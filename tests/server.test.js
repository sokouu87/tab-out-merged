import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE_NAME, startTabOutServer } from '../server/app.mjs';
import {
  createPasswordRecord,
  SESSION_MAX_AGE_SECONDS,
  signSessionToken,
  verifySessionToken,
} from '../server/security.mjs';

const TEST_PASSWORD = 'test-password-only';
const TEST_USERNAME = 'test-user';
const TEST_EXTENSION_KEY = 'ab'.repeat(32);
const TEST_COOKIE_SECRET = 'cd'.repeat(32);

describe('会话 cookie', () => {
  test('签名后的 cookie 可以验签', () => {
    const now = Date.UTC(2026, 7, 5, 10, 0, 0);
    const token = signSessionToken(TEST_USERNAME, TEST_COOKIE_SECRET, now);

    expect(verifySessionToken(token, {
      username: TEST_USERNAME,
      secretHex: TEST_COOKIE_SECRET,
      now: now + 1_000,
    })).toMatchObject({ u: TEST_USERNAME });
  });

  test('过期 cookie 被拒绝', () => {
    const issuedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const token = signSessionToken(TEST_USERNAME, TEST_COOKIE_SECRET, issuedAt);

    expect(verifySessionToken(token, {
      username: TEST_USERNAME,
      secretHex: TEST_COOKIE_SECRET,
      now: issuedAt + (SESSION_MAX_AGE_SECONDS + 1) * 1000,
    })).toBeNull();
  });
});

describe('远程查看器 API', () => {
  let instance;
  let tempDir;
  let baseUrl;
  let config;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tab-out-server-test-'));
    config = {
      username: TEST_USERNAME,
      ...(await createPasswordRecord(TEST_PASSWORD, randomBytes(16).toString('hex'))),
      cookieSecret: TEST_COOKIE_SECRET,
      extensionKey: TEST_EXTENSION_KEY,
    };
    instance = await startTabOutServer({
      config,
      dataDir: path.join(tempDir, 'data'),
      host: '127.0.0.1',
      port: 0,
      pages: { loginHtml: '<p>login</p>', mobileHtml: '<p>mobile</p>' },
    });
    baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  });

  afterAll(async () => {
    if (instance?.server) await new Promise(resolve => instance.server.close(resolve));
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function login(password = TEST_PASSWORD) {
    return fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password }),
    });
  }

  async function authenticatedCookie() {
    const response = await login();
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie').split(';')[0];
  }

  test('错误密码被拒绝', async () => {
    const response = await login('wrong-password');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });

  test('错误扩展 key 被拒绝', async () => {
    const response = await fetch(`${baseUrl}/api/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TabOut-Key': 'wrong-key',
      },
      body: JSON.stringify({ tabs: [], saved: [], ts: Date.now() }),
    });
    expect(response.status).toBe(401);
  });

  test('未登录访问快捷方式和图标端点被拒绝', async () => {
    const [shortcutsResponse, iconResponse] = await Promise.all([
      fetch(`${baseUrl}/api/shortcuts`),
      fetch(`${baseUrl}/api/icon?u=${encodeURIComponent('https://github.com')}`),
    ]);

    expect(shortcutsResponse.status).toBe(401);
    expect(iconResponse.status).toBe(401);
  });

  test('快捷方式超过 10 条被拒绝', async () => {
    const cookie = await authenticatedCookie();
    const response = await fetch(`${baseUrl}/api/shortcuts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(Array.from({ length: 11 }, (_, index) => ({
        url: `https://example${index}.test`,
        title: `Example ${index}`,
        position: index,
      }))),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });

  test('快捷方式拒绝非 HTTP 或 HTTPS URL', async () => {
    const cookie = await authenticatedCookie();
    const response = await fetch(`${baseUrl}/api/shortcuts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify([{ url: 'javascript:alert(1)', title: '危险链接', position: 0 }]),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });

  test('快捷方式拒绝超长字段', async () => {
    const cookie = await authenticatedCookie();
    const response = await fetch(`${baseUrl}/api/shortcuts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify([{ url: 'https://example.test', title: 'x'.repeat(101), position: 0 }]),
    });

    expect(response.status).toBe(400);
  });

  test('快捷方式可以整份写入并按位置读回', async () => {
    const cookie = await authenticatedCookie();
    const shortcuts = [
      { url: 'https://github.com', title: 'GitHub', position: 0 },
      { url: 'https://youtube.com', title: 'YouTube', position: 1 },
      { url: 'https://x.com', title: 'X', position: 2 },
    ];
    const putResponse = await fetch(`${baseUrl}/api/shortcuts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(shortcuts),
    });
    expect(putResponse.status).toBe(200);

    const getResponse = await fetch(`${baseUrl}/api/shortcuts`, { headers: { Cookie: cookie } });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(shortcuts);
  });

  test('含 recentlyClosed 的快照可以写入并从状态端点读回', async () => {
    const cookie = await authenticatedCookie();
    const recentlyClosed = [{
      sessionId: 'recent-tab-1',
      url: 'https://recent-only.example/article',
      title: '刚关闭的文章',
      favIconUrl: 'https://recent-only.example/favicon.ico',
      closedAt: Date.now() - 1_000,
      kind: 'tab',
      tabCount: 1,
    }];
    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TabOut-Key': TEST_EXTENSION_KEY,
      },
      body: JSON.stringify({ tabs: [], saved: [], recentlyClosed, ts: Date.now() }),
    });
    expect(snapshotResponse.status).toBe(200);

    const stateResponse = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } });
    expect(stateResponse.status).toBe(200);
    expect((await stateResponse.json()).recentlyClosed).toEqual(recentlyClosed);
  });

  test('旧快照缺少 recentlyClosed 时状态端点仍返回空数组', async () => {
    const oldTempDir = await mkdtemp(path.join(tmpdir(), 'tab-out-old-snapshot-test-'));
    const dataDir = path.join(oldTempDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'snapshot.json'), JSON.stringify({
      tabs: [{ id: 9, url: 'https://old.example', title: '旧快照' }],
      saved: [],
      ts: Date.now() - 5_000,
      lastSyncTs: Date.now() - 5_000,
    }), 'utf8');

    const oldInstance = await startTabOutServer({
      config,
      dataDir,
      host: '127.0.0.1',
      port: 0,
      pages: { loginHtml: '<p>login</p>', mobileHtml: '<p>mobile</p>' },
    });
    try {
      const oldBaseUrl = `http://127.0.0.1:${oldInstance.server.address().port}`;
      const cookie = `${SESSION_COOKIE_NAME}=${signSessionToken(TEST_USERNAME, TEST_COOKIE_SECRET, Date.now())}`;
      const response = await fetch(`${oldBaseUrl}/api/state`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ recentlyClosed: [] });
    } finally {
      await new Promise(resolve => oldInstance.server.close(resolve));
      await rm(oldTempDir, { recursive: true, force: true });
    }
  });

  test('图标白名单接受只出现在 recentlyClosed 中的 host，SSRF 防护仍会拦截私网', async () => {
    const cookie = await authenticatedCookie();
    const target = 'http://127.0.0.1/recently-closed';
    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TabOut-Key': TEST_EXTENSION_KEY,
      },
      body: JSON.stringify({
        tabs: [],
        saved: [],
        recentlyClosed: [{
          sessionId: 'recent-private-host',
          url: target,
          title: '白名单来源测试',
          favIconUrl: '',
          closedAt: Date.now(),
        }],
        ts: Date.now(),
      }),
    });
    expect(snapshotResponse.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/icon?u=${encodeURIComponent(target)}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(400);
    expect(response.status).not.toBe(403);
  });

  test('图标端点拒绝没在快捷方式或当前标签里出现过的站点', async () => {
    const cookie = await authenticatedCookie();
    await fetch(`${baseUrl}/api/shortcuts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify([{ url: 'https://github.com', title: 'GitHub', position: 0 }]),
    });

    const response = await fetch(`${baseUrl}/api/icon?u=${encodeURIComponent('https://never-seen.example')}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  test('图标端点拒绝回环和私有网段 URL，即使它们已被加进快捷方式', async () => {
    // 白名单只是第一道门。这里先把私有地址塞进快捷方式让它通过白名单，
    // 验证 icon-proxy 自己的 SSRF 防护仍然独立拦截——两层都得管用。
    const cookie = await authenticatedCookie();
    const targets = ['http://127.0.0.1/favicon.ico', 'http://192.168.1.1/favicon.ico', 'http://[::1]/favicon.ico'];
    await fetch(`${baseUrl}/api/shortcuts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(targets.map((url, position) => ({ url, title: `t${position}`, position }))),
    });

    for (const target of targets) {
      const response = await fetch(`${baseUrl}/api/icon?u=${encodeURIComponent(target)}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status, target).toBe(400);
    }
  });

  test('手机指令可以入队，并在 ack 后出队', async () => {
    const loginResponse = await login();
    expect(loginResponse.status).toBe(200);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TabOut-Key': TEST_EXTENSION_KEY,
      },
      body: JSON.stringify({
        tabs: [{ id: 42, url: 'https://example.test', title: 'Example', firstSeenTs: Date.now() }],
        saved: [],
        ts: Date.now(),
      }),
    });
    expect(snapshotResponse.status).toBe(200);

    const actionResponse = await fetch(`${baseUrl}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'close', tabId: 42 }),
    });
    expect(actionResponse.status).toBe(200);
    expect(await actionResponse.json()).toMatchObject({ pendingCount: 1 });

    const commandsResponse = await fetch(`${baseUrl}/api/commands?wait=0`, {
      headers: { 'X-TabOut-Key': TEST_EXTENSION_KEY },
    });
    const commands = await commandsResponse.json();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'close', tabId: 42 });

    const ackResponse = await fetch(`${baseUrl}/api/commands/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TabOut-Key': TEST_EXTENSION_KEY,
      },
      body: JSON.stringify({ ids: [commands[0].id] }),
    });
    expect(ackResponse.status).toBe(200);
    expect(await ackResponse.json()).toMatchObject({ pendingCount: 0 });

    const emptyResponse = await fetch(`${baseUrl}/api/commands?wait=0`, {
      headers: { 'X-TabOut-Key': TEST_EXTENSION_KEY },
    });
    expect(await emptyResponse.json()).toEqual([]);
  });
});
