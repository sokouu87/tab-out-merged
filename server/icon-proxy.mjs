import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';

export const ICON_CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ICON_CACHE_MAX_AGE_MS = ICON_CACHE_MAX_AGE_SECONDS * 1000;
const ICON_REQUEST_TIMEOUT_MS = 5_000;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_ICON_REDIRECTS = 3;
const MAX_PAGE_URL_LENGTH = 2048;

class IconProxyError extends Error {
  constructor(message, statusCode = 404) {
    super(message);
    this.statusCode = statusCode;
  }
}

function blockedIpv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function ipv6Bytes(address) {
  let source = address.toLowerCase().split('%')[0];
  const ipv4Match = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const octets = ipv4Match[1].split('.').map(Number);
    source = `${source.slice(0, -ipv4Match[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  return groups.flatMap(group => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function blockedIpv6(address) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZeroPrefix = bytes.slice(0, 15).every(byte => byte === 0);
  if (allZeroPrefix && (bytes[15] === 0 || bytes[15] === 1)) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;

  const mappedIpv4 = bytes.slice(0, 10).every(byte => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  const compatibleIpv4 = bytes.slice(0, 12).every(byte => byte === 0);
  if (mappedIpv4 || compatibleIpv4) return blockedIpv4(bytes.slice(12).join('.'));
  return false;
}

function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family === 6) return blockedIpv6(address);
  return true;
}

function isProxyFakeIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

function parsePublicHttpUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PAGE_URL_LENGTH) {
    throw new IconProxyError('图标 URL 无效或过长。', 400);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new IconProxyError('图标 URL 格式无效。', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new IconProxyError('图标 URL 只支持 HTTP 或 HTTPS。', 400);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || (isIP(hostname) && (isBlockedAddress(hostname) || isProxyFakeIpv4(hostname)))) {
    throw new IconProxyError('拒绝访问私有网段或回环地址。', 400);
  }
  return parsed;
}

async function resolvePublicAddress(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized)) {
    if (isBlockedAddress(normalized)) throw new IconProxyError('拒绝访问私有网段或回环地址。', 400);
    return { address: normalized, family: isIP(normalized) };
  }

  let addresses;
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new IconProxyError('目标站点无法解析。');
  }
  if (!addresses.length) throw new IconProxyError('目标站点无法解析。');
  const publicAddresses = addresses.filter(item => !isBlockedAddress(item.address));
  if (!publicAddresses.length) {
    throw new IconProxyError('拒绝访问解析到私有网段或回环地址的站点。', 400);
  }
  // 只连接这里选出的已校验地址；混合 DNS 响应中的私网地址不会被使用。
  return publicAddresses.find(item => item.family === 4) || publicAddresses[0];
}

function sniffImageContentType(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) return 'image/x-icon';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const prefix = buffer.subarray(0, 512).toString('utf8').replace(/^\uFEFF?\s*/, '');
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(prefix)) return 'image/svg+xml';
  return null;
}

async function requestImage(target, redirectCount = 0) {
  const parsed = parsePublicHttpUrl(target instanceof URL ? target.href : target);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const { address, family } = await resolvePublicAddress(hostname);
  const transport = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: address,
      family,
      port: parsed.port || undefined,
      method: 'GET',
      path: `${parsed.pathname}${parsed.search}`,
      servername: isIP(hostname) ? undefined : hostname,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8',
        Host: parsed.host,
        'User-Agent': 'Tab-Out-Icon-Proxy/1.0',
      },
    }, response => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirectCount >= MAX_ICON_REDIRECTS) {
          reject(new IconProxyError('图标重定向次数过多。'));
          return;
        }
        resolve(requestImage(new URL(location, parsed), redirectCount + 1));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new IconProxyError(`图标源返回 HTTP ${statusCode}。`));
        return;
      }

      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ICON_BYTES) {
        response.destroy();
        reject(new IconProxyError('图标超过 256 KB 上限。'));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ICON_BYTES) {
          response.destroy(new IconProxyError('图标超过 256 KB 上限。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const contentType = sniffImageContentType(body);
        if (!contentType) {
          reject(new IconProxyError('图标源没有返回有效图片。'));
          return;
        }
        resolve({ body, contentType });
      });
      response.on('error', reject);
    });
    request.setTimeout(ICON_REQUEST_TIMEOUT_MS, () => request.destroy(new IconProxyError('图标抓取超时。')));
    request.on('error', reject);
    request.end();
  });
}

function cacheFileForHost(iconDir, hostname) {
  const normalized = hostname.toLowerCase();
  const readable = normalized.replace(/[^a-z0-9.-]+/g, '_').slice(0, 80) || 'host';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return path.join(iconDir, `${readable}-${digest}.img`);
}

async function readFreshCache(filePath, now) {
  try {
    const info = await stat(filePath);
    if (now - info.mtimeMs > ICON_CACHE_MAX_AGE_MS) return null;
    const body = await readFile(filePath);
    const contentType = sniffImageContentType(body);
    return contentType ? { body, contentType, cacheHit: true, filePath } : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(filePath, body) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, body, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    throw error;
  }
}

export async function getIconForPage(pageUrl, dataDir, now = Date.now()) {
  const parsed = parsePublicHttpUrl(pageUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  const iconDir = path.join(dataDir, 'icons');
  const filePath = cacheFileForHost(iconDir, hostname);
  const cached = await readFreshCache(filePath, now);
  if (cached) return cached;

  await resolvePublicAddress(hostname);

  const candidates = [
    new URL('/favicon.ico', parsed),
    new URL(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`),
  ];
  for (const candidate of candidates) {
    try {
      const icon = await requestImage(candidate);
      await mkdir(iconDir, { recursive: true });
      await atomicWrite(filePath, icon.body);
      return { ...icon, cacheHit: false, filePath };
    } catch (error) {
      if (error?.statusCode === 400 && candidate === candidates[0]) continue;
    }
  }
  return null;
}
