import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCookies,
  secretsEqual,
  SESSION_MAX_AGE_SECONDS,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from './security.mjs';
import { PersistentStore } from './storage.mjs';
import { getIconForPage, ICON_CACHE_MAX_AGE_SECONDS } from './icon-proxy.mjs';

export const SESSION_COOKIE_NAME = 'tabout_session';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROUTES = new Set(['/api/snapshot', '/api/commands', '/api/commands/ack']);
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SHORTCUTS = 10;
const MAX_SHORTCUT_URL_LENGTH = 2048;
const MAX_SHORTCUT_TITLE_LENGTH = 100;

function send(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function sendIcon(response, icon) {
  response.writeHead(200, {
    'Content-Type': icon.contentType,
    'Content-Length': icon.body.length,
    'Cache-Control': `public, max-age=${ICON_CACHE_MAX_AGE_SECONDS}`,
    'X-Content-Type-Options': 'nosniff',
    'X-Tab-Out-Icon-Cache': icon.cacheHit ? 'HIT' : 'MISS',
    Vary: 'Cookie',
  });
  response.end(icon.body);
}

function sendAppleTouchIcon(response, body) {
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': body.length,
    'Cache-Control': `public, max-age=${ICON_CACHE_MAX_AGE_SECONDS}`,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求内容过大。');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('请求 JSON 格式无效。');
    error.statusCode = 400;
    throw error;
  }
}

function validateShortcuts(value) {
  if (!Array.isArray(value) || value.length > MAX_SHORTCUTS) {
    throw Object.assign(new Error('快捷方式必须是最多 10 条的列表。'), { statusCode: 400 });
  }

  const positions = new Set();
  const shortcuts = value.map(shortcut => {
    if (!shortcut || typeof shortcut !== 'object' || Array.isArray(shortcut)) {
      throw Object.assign(new Error('快捷方式格式无效。'), { statusCode: 400 });
    }
    if (typeof shortcut.url !== 'string' || !shortcut.url.trim() || shortcut.url.length > MAX_SHORTCUT_URL_LENGTH) {
      throw Object.assign(new Error('快捷方式 URL 无效或过长。'), { statusCode: 400 });
    }
    if (typeof shortcut.title !== 'string' || shortcut.title.length > MAX_SHORTCUT_TITLE_LENGTH) {
      throw Object.assign(new Error('快捷方式标题无效或过长。'), { statusCode: 400 });
    }
    if (!Number.isInteger(shortcut.position) || shortcut.position < 0 || shortcut.position >= MAX_SHORTCUTS || positions.has(shortcut.position)) {
      throw Object.assign(new Error('快捷方式位置无效或重复。'), { statusCode: 400 });
    }

    let parsed;
    try {
      parsed = new URL(shortcut.url.trim());
    } catch {
      throw Object.assign(new Error('快捷方式 URL 格式无效。'), { statusCode: 400 });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw Object.assign(new Error('快捷方式 URL 只支持 HTTP 或 HTTPS。'), { statusCode: 400 });
    }

    positions.add(shortcut.position);
    return {
      url: shortcut.url.trim(),
      title: shortcut.title.trim(),
      position: shortcut.position,
    };
  });

  return shortcuts.sort((left, right) => left.position - right.position);
}

function hostOf(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 目标 host 是否出现在用户自己的数据里——快捷方式、当前标签、稍后再看、最近关闭。
 * 见 /api/icon 路由处的注释：这是 fake-ip 环境下 SSRF 防护的兜底。
 */
function isKnownIconHost(requestedUrl, store, now) {
  const host = hostOf(requestedUrl);
  if (!host) return false;

  const state = store.getState(now);
  const sources = [
    ...store.getShortcuts(),
    ...(state.tabs || []),
    ...(state.saved || []),
    ...(state.recentlyClosed || []),
  ];
  return sources.some(item => hostOf(item?.url) === host);
}

function getClientIp(request) {
  const cloudflareIp = request.headers['cf-connecting-ip'];
  if (typeof cloudflareIp === 'string' && cloudflareIp.trim()) return cloudflareIp.trim();
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress || 'unknown';
}

function sessionForRequest(request, config, now) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
  return verifySessionToken(token, {
    username: config.username,
    secretHex: config.cookieSecret,
    now,
  });
}

function extensionAuthorized(request, config) {
  return secretsEqual(request.headers['x-tabout-key'], config.extensionKey);
}

export async function createTabOutServer({ config, dataDir, now = () => Date.now(), pages = {} }) {
  const [loginHtml, mobileHtml, appleTouchIcon] = await Promise.all([
    pages.loginHtml ?? readFile(path.join(MODULE_DIR, 'login.html'), 'utf8'),
    pages.mobileHtml ?? readFile(path.join(MODULE_DIR, 'mobile.html'), 'utf8'),
    pages.appleTouchIcon ?? readFile(path.join(MODULE_DIR, '..', 'extension', 'icons', 'icon128.png')),
  ]);
  const store = new PersistentStore(dataDir);
  await store.init();
  const loginAttempts = new Map();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const route = url.pathname;
      const currentTime = now();

      // 会话 cookie 带 Secure，只有 https 连接才会被浏览器保存。走 http 访问时
      // 登录本身会成功、Set-Cookie 也会下发，但浏览器直接丢弃，页面一 reload
      // 又退回登录页——看起来像"密码不对"，其实是协议不对。
      //
      // 只在经由 Cloudflare 时重定向：X-Forwarded-Proto 由隧道注入，本地直连
      // 127.0.0.1:8787 没有这个头，不受影响，诊断照常可用。
      const forwardedProto = request.headers['x-forwarded-proto'];
      if (forwardedProto && forwardedProto !== 'https') {
        const host = request.headers['x-forwarded-host'] || request.headers.host;
        if (host) {
          response.writeHead(301, { Location: `https://${host}${request.url || '/'}` });
          response.end();
          return;
        }
      }

      if (route === '/api/login' && request.method === 'POST') {
        const ip = getClientIp(request);
        const attempt = loginAttempts.get(ip);
        if (attempt?.lockedUntil > currentTime) {
          sendJson(response, 429, { error: '登录失败次数过多，请 15 分钟后再试。' });
          return;
        }
        if (attempt?.lockedUntil && attempt.lockedUntil <= currentTime) loginAttempts.delete(ip);

        const body = await readJson(request);
        const usernameMatches = secretsEqual(body.username, config.username);
        const passwordMatches = await verifyPassword(String(body.password ?? ''), config);
        if (!usernameMatches || !passwordMatches) {
          const previousFailures = loginAttempts.get(ip)?.failures || 0;
          const failures = previousFailures + 1;
          loginAttempts.set(ip, {
            failures,
            lockedUntil: failures >= 5 ? currentTime + LOGIN_LOCK_MS : 0,
          });
          sendJson(response, 401, { error: '用户名或密码错误。' });
          return;
        }

        loginAttempts.delete(ip);
        const token = signSessionToken(config.username, config.cookieSecret, currentTime);
        sendJson(response, 200, { ok: true }, {
          'Set-Cookie': `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        });
        return;
      }

      if (route === '/apple-touch-icon.png' && request.method === 'GET') {
        sendAppleTouchIcon(response, appleTouchIcon);
        return;
      }

      if (EXTENSION_ROUTES.has(route)) {
        if (!extensionAuthorized(request, config)) {
          sendJson(response, 401, { error: '扩展密钥无效。' });
          return;
        }

        if (route === '/api/snapshot' && request.method === 'POST') {
          const body = await readJson(request);
          if (
            !Array.isArray(body.tabs)
            || !Array.isArray(body.saved)
            || (body.recentlyClosed !== undefined && !Array.isArray(body.recentlyClosed))
            || !Number.isFinite(body.ts)
          ) {
            sendJson(response, 400, { error: '快照格式无效。' });
            return;
          }
          await store.replaceSnapshot({
            tabs: body.tabs,
            saved: body.saved,
            recentlyClosed: body.recentlyClosed || [],
            ts: body.ts,
          }, currentTime);
          sendJson(response, 200, { ok: true });
          return;
        }

        if (route === '/api/commands' && request.method === 'GET') {
          const waitSeconds = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 25);
          const abortController = new AbortController();
          request.on('aborted', () => abortController.abort());
          response.on('close', () => abortController.abort());
          const commands = await store.waitForCommands(waitSeconds * 1000, abortController.signal);
          if (!response.writableEnded && !response.destroyed) sendJson(response, 200, commands);
          return;
        }

        if (route === '/api/commands/ack' && request.method === 'POST') {
          const body = await readJson(request);
          if (!Array.isArray(body.ids) || body.ids.some(id => typeof id !== 'string')) {
            sendJson(response, 400, { error: '指令 ID 格式无效。' });
            return;
          }
          const pendingCount = await store.acknowledgeCommands(body.ids);
          sendJson(response, 200, { ok: true, pendingCount });
          return;
        }

        sendJson(response, 405, { error: '请求方法不受支持。' });
        return;
      }

      const session = sessionForRequest(request, config, currentTime);
      if (route === '/' && request.method === 'GET' && !session) {
        send(response, 200, loginHtml, 'text/html; charset=utf-8');
        return;
      }
      if (!session) {
        sendJson(response, 401, { error: '请先登录。' });
        return;
      }

      if (route === '/' && request.method === 'GET') {
        send(response, 200, mobileHtml, 'text/html; charset=utf-8');
        return;
      }

      if (route === '/api/state' && request.method === 'GET') {
        sendJson(response, 200, store.getState(currentTime));
        return;
      }

      if (route === '/api/shortcuts' && request.method === 'GET') {
        sendJson(response, 200, store.getShortcuts());
        return;
      }

      if (route === '/api/shortcuts' && request.method === 'PUT') {
        const body = await readJson(request);
        sendJson(response, 200, await store.replaceShortcuts(validateShortcuts(body)));
        return;
      }

      if (route === '/api/icon' && request.method === 'GET') {
        // 只给已经出现在快捷方式、当前标签、稍后再看或最近关闭里的站点取图标。
        //
        // icon-proxy 自己有一整套 SSRF 防护（私网段、IPv6、重定向、DNS 解析后校验），
        // 但在这台机器上它有个前提不成立：mihomo 开着 fake-ip，把所有域名都解析成
        // 198.18.x.x —— 包括 github.com。于是"解析后检查 IP"看到的永远是同一个假段，
        // 一律判为公网放行，真正连去哪由 mihomo 的规则决定，那层防护形同虚设。
        // 又不能把 198.18/19 直接拉黑，那样正常图标也全取不到。
        //
        // 所以在这一层加白名单兜底：目标 host 必须是用户自己已经收藏或打开过的。
        // 功能上没有损失（图标本来就只服务这两处），但攻击面从"任意 URL"收敛到
        // "用户自己的浏览记录"，fake-ip 那条路也就没得走了。
        const requestedUrl = url.searchParams.get('u');
        if (!isKnownIconHost(requestedUrl, store, currentTime)) {
          sendJson(response, 403, { error: '只能获取已保存或当前打开的站点图标。' });
          return;
        }
        const icon = await getIconForPage(requestedUrl, dataDir, currentTime);
        if (!icon) {
          sendJson(response, 404, { error: '没有找到可用的网站图标。' });
          return;
        }
        sendIcon(response, icon);
        return;
      }

      if (route === '/api/action' && request.method === 'POST') {
        const state = store.getState(currentTime);
        if (!state.online) {
          sendJson(response, 409, { error: '家里的浏览器当前离线，操作没有加入队列。' });
          return;
        }
        const body = await readJson(request);
        if (!['close', 'save'].includes(body.type) || !Number.isInteger(body.tabId)) {
          sendJson(response, 400, { error: '操作格式无效。' });
          return;
        }
        if (!state.tabs.some(tab => tab.id === body.tabId)) {
          sendJson(response, 409, { error: '这个标签已经不在当前快照中。' });
          return;
        }
        await store.enqueueCommand(body.type, body.tabId, currentTime);
        sendJson(response, 200, { ok: true, pendingCount: store.getCommands().length });
        return;
      }

      sendJson(response, 404, { error: '页面不存在。' });
    } catch (error) {
      console.error('[tab-out-server]', error);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : '服务暂时不可用。' });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });

  return { server, store };
}

export async function startTabOutServer(options) {
  const { host = '127.0.0.1', port = 8787 } = options;
  const instance = await createTabOutServer(options);
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(port, host, () => {
      instance.server.off('error', reject);
      resolve();
    });
  });
  return instance;
}
