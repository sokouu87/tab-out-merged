import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { startTabOutServer } from '../server/app.mjs';
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
