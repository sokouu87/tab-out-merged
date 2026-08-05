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

export const SESSION_COOKIE_NAME = 'tabout_session';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROUTES = new Set(['/api/snapshot', '/api/commands', '/api/commands/ack']);
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

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
  const [loginHtml, mobileHtml] = await Promise.all([
    pages.loginHtml ?? readFile(path.join(MODULE_DIR, 'login.html'), 'utf8'),
    pages.mobileHtml ?? readFile(path.join(MODULE_DIR, 'mobile.html'), 'utf8'),
  ]);
  const store = new PersistentStore(dataDir);
  await store.init();
  const loginAttempts = new Map();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const route = url.pathname;
      const currentTime = now();

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

      if (EXTENSION_ROUTES.has(route)) {
        if (!extensionAuthorized(request, config)) {
          sendJson(response, 401, { error: '扩展密钥无效。' });
          return;
        }

        if (route === '/api/snapshot' && request.method === 'POST') {
          const body = await readJson(request);
          if (!Array.isArray(body.tabs) || !Array.isArray(body.saved) || !Number.isFinite(body.ts)) {
            sendJson(response, 400, { error: '快照格式无效。' });
            return;
          }
          await store.replaceSnapshot({ tabs: body.tabs, saved: body.saved, ts: body.ts }, currentTime);
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
