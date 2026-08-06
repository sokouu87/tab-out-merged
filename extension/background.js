/**
 * Tab Out MV3 service worker。
 * 负责工具栏徽章、标签首次出现时间，以及可选的远程双向同步。
 */

'use strict';

if (typeof importScripts === 'function') importScripts('shared.js');

const shared = globalThis.TabOutShared;
const REMOTE_STATUS_KEY = 'remoteConnectionStatus';
const FIRST_SEEN_KEY = 'tabFirstSeen';
const REMOTE_RETRY_MAX_MS = 30_000;
const FALLBACK_SETTINGS = {
  refreshIntervalSeconds: 30,
  remoteSyncEnabled: false,
  // 与 shared.js 保持一致：localhost 在 Windows 上会先走 IPv6 ::1，连不上只监听
  // 127.0.0.1 的服务。
  remoteServerUrl: 'http://127.0.0.1:8787',
  extensionKey: '',
};

let firstSeenMutation = Promise.resolve();
let remoteGeneration = 0;
let remoteControllers = new Set();
let snapshotInFlight = null;

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(tab => {
      const url = tab.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count === 0) return;
    const color = count <= 10 ? '#3d7a4a' : count <= 20 ? '#b8892e' : '#b35a5a';
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    try { await chrome.action.setBadgeText({ text: '' }); } catch {}
  }
}

async function openDashboard() {
  const dashboardUrl = chrome.runtime.getURL('index.html');
  try {
    const existing = await chrome.tabs.query({ url: dashboardUrl });
    if (existing.length > 0) {
      const tab = existing[0];
      await chrome.tabs.update(tab.id, { active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
      return;
    }
    await chrome.tabs.create({ url: dashboardUrl });
  } catch {
    try { await chrome.tabs.create({}); } catch {}
  }
}

function queueFirstSeenMutation(callback) {
  const result = firstSeenMutation.then(callback, callback);
  firstSeenMutation = result.catch(error => {
    console.warn('[tab-out] tabFirstSeen 更新失败：', error);
  });
  return result;
}

function recordTabCreated(tab) {
  if (!Number.isInteger(tab?.id)) return Promise.resolve();
  return queueFirstSeenMutation(async () => {
    const stored = await chrome.storage.local.get(FIRST_SEEN_KEY);
    const firstSeen = { ...(stored[FIRST_SEEN_KEY] || {}) };
    if (!Number.isFinite(firstSeen[tab.id])) {
      firstSeen[tab.id] = Date.now();
      await chrome.storage.local.set({ [FIRST_SEEN_KEY]: firstSeen });
    }
  });
}

function removeTabFirstSeen(tabId) {
  return queueFirstSeenMutation(async () => {
    const stored = await chrome.storage.local.get(FIRST_SEEN_KEY);
    const firstSeen = { ...(stored[FIRST_SEEN_KEY] || {}) };
    if (Object.prototype.hasOwnProperty.call(firstSeen, tabId)) {
      delete firstSeen[tabId];
      await chrome.storage.local.set({ [FIRST_SEEN_KEY]: firstSeen });
    }
  });
}

function reconcileTabFirstSeen() {
  return queueFirstSeenMutation(async () => {
    const [tabs, stored] = await Promise.all([
      chrome.tabs.query({}),
      chrome.storage.local.get(FIRST_SEEN_KEY),
    ]);
    const previous = stored[FIRST_SEEN_KEY] || {};
    const next = {};
    const now = Date.now();
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) continue;
      next[tab.id] = Number.isFinite(previous[tab.id]) ? previous[tab.id] : now;
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      await chrome.storage.local.set({ [FIRST_SEEN_KEY]: next });
    }
    return next;
  });
}

async function loadSettings() {
  try {
    if (shared?.getSettings) return await shared.getSettings();
    const { settings } = await chrome.storage.local.get('settings');
    return { ...FALLBACK_SETTINGS, ...(settings || {}) };
  } catch {
    return { ...FALLBACK_SETTINGS };
  }
}

function normalizeServerUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址只支持 HTTP 或 HTTPS。');
  return url.href.replace(/\/$/, '');
}

async function setRemoteStatus(state, message = '') {
  try {
    await chrome.storage.local.set({
      [REMOTE_STATUS_KEY]: {
        state,
        message,
        updatedAt: Date.now(),
        ...(state === 'connected' ? { lastConnectedAt: Date.now() } : {}),
      },
    });
  } catch {}
}

function createFetchController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  remoteControllers.add(controller);
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      remoteControllers.delete(controller);
    },
  };
}

async function remoteFetch(url, options, timeoutMs) {
  const controller = createFetchController(timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    controller.release();
  }
}

async function buildSnapshot() {
  await firstSeenMutation;
  const [tabs, stored, recentlyClosed] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get([FIRST_SEEN_KEY, 'deferred']),
    shared?.getRecentlyClosedSnapshot ? shared.getRecentlyClosedSnapshot() : [],
  ]);
  const firstSeen = stored[FIRST_SEEN_KEY] || {};
  const now = Date.now();
  const missing = tabs.some(tab => Number.isInteger(tab.id) && !Number.isFinite(firstSeen[tab.id]));
  const reconciled = missing ? await reconcileTabFirstSeen() : firstSeen;
  return {
    tabs: tabs.filter(tab => Number.isInteger(tab.id)).map(tab => ({
      id: tab.id,
      url: tab.url || '',
      title: tab.title || tab.url || '',
      favIconUrl: tab.favIconUrl || '',
      firstSeenTs: reconciled[tab.id] || now,
      pinned: Boolean(tab.pinned),
      discarded: Boolean(tab.discarded),
      audible: Boolean(tab.audible),
    })),
    saved: Array.isArray(stored.deferred) ? stored.deferred : [],
    recentlyClosed,
    ts: now,
  };
}

async function pushSnapshot(settings) {
  if (snapshotInFlight) return snapshotInFlight;
  const operation = (async () => {
    const baseUrl = normalizeServerUrl(settings.remoteServerUrl);
    const response = await remoteFetch(`${baseUrl}/api/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TabOut-Key': settings.extensionKey,
      },
      body: JSON.stringify(await buildSnapshot()),
    }, 12_000);
    if (!response.ok) throw new Error(`快照推送失败（HTTP ${response.status}）`);
    await setRemoteStatus('connected', '已连接');
  })();
  snapshotInFlight = operation;
  try {
    return await operation;
  } finally {
    if (snapshotInFlight === operation) snapshotInFlight = null;
  }
}

async function postAck(settings, ids) {
  const baseUrl = normalizeServerUrl(settings.remoteServerUrl);
  const response = await remoteFetch(`${baseUrl}/api/commands/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TabOut-Key': settings.extensionKey,
    },
    body: JSON.stringify({ ids }),
  }, 12_000);
  if (!response.ok) throw new Error(`指令确认失败（HTTP ${response.status}）`);
}

async function executeCommand(command) {
  if (!['close', 'save'].includes(command?.type) || !Number.isInteger(command.tabId)) return true;
  const tab = await chrome.tabs.get(command.tabId).catch(() => null);
  if (!tab) return true;

  if (command.type === 'save') {
    if (!shared?.saveTabForLater) throw new Error('共享收藏逻辑未加载。');
    await shared.saveTabForLater({
      url: tab.url || '',
      title: tab.title || tab.url || '',
      favIconUrl: tab.favIconUrl || '',
    });
  }
  await chrome.tabs.remove(command.tabId);
  return true;
}

async function processCommands(settings, commands) {
  const acknowledged = [];
  for (const command of commands) {
    try {
      await executeCommand(command);
      if (typeof command.id === 'string') acknowledged.push(command.id);
    } catch (error) {
      console.warn('[tab-out] 远程指令执行失败：', command, error);
    }
  }
  if (acknowledged.length > 0) await postAck(settings, acknowledged);
  if (commands.length > 0) await pushSnapshot(settings);
}

function delay(ms, generation) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (generation !== remoteGeneration) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function commandLoop(settings, generation) {
  let retryMs = 1000;
  while (generation === remoteGeneration) {
    try {
      const baseUrl = normalizeServerUrl(settings.remoteServerUrl);
      const response = await remoteFetch(`${baseUrl}/api/commands?wait=25`, {
        headers: { 'X-TabOut-Key': settings.extensionKey },
      }, 35_000);
      if (!response.ok) throw new Error(`指令拉取失败（HTTP ${response.status}）`);
      const payload = await response.json();
      const commands = Array.isArray(payload) ? payload : payload.commands;
      if (!Array.isArray(commands)) throw new Error('指令响应格式无效。');
      await setRemoteStatus('connected', '已连接');
      await processCommands(settings, commands);
      retryMs = 1000;
    } catch (error) {
      if (generation !== remoteGeneration) return;
      await setRemoteStatus('error', error.name === 'AbortError' ? '连接超时' : error.message);
      await delay(retryMs, generation);
      retryMs = Math.min(retryMs * 2, REMOTE_RETRY_MAX_MS);
    }
  }
}

async function snapshotLoop(settings, generation) {
  const intervalSeconds = Number(settings.refreshIntervalSeconds);
  if (![10, 30, 60].includes(intervalSeconds)) return;
  while (generation === remoteGeneration) {
    await delay(intervalSeconds * 1000, generation);
    if (generation !== remoteGeneration) return;
    try {
      await pushSnapshot(settings);
    } catch (error) {
      if (generation === remoteGeneration) await setRemoteStatus('error', error.message);
    }
  }
}

async function restartRemoteSync() {
  remoteGeneration += 1;
  const generation = remoteGeneration;
  for (const controller of remoteControllers) controller.abort();
  remoteControllers = new Set();
  snapshotInFlight = null;

  const settings = await loadSettings();
  if (generation !== remoteGeneration) return;
  if (!settings.remoteSyncEnabled) {
    await setRemoteStatus('disabled', '远程同步已关闭');
    return;
  }
  if (!settings.extensionKey) {
    await setRemoteStatus('error', '请填写 extensionKey');
    return;
  }

  try {
    normalizeServerUrl(settings.remoteServerUrl);
  } catch (error) {
    await setRemoteStatus('error', error.message);
    return;
  }

  await setRemoteStatus('connecting', '正在连接');
  pushSnapshot(settings).catch(error => {
    if (generation === remoteGeneration) setRemoteStatus('error', error.message);
  });
  commandLoop(settings, generation);
  snapshotLoop(settings, generation);
}

chrome.action.onClicked.addListener(() => {
  openDashboard();
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  reconcileTabFirstSeen();
  restartRemoteSync();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  reconcileTabFirstSeen();
  restartRemoteSync();
});

chrome.tabs.onCreated.addListener(tab => {
  updateBadge();
  recordTabCreated(tab);
});

chrome.tabs.onRemoved.addListener(tabId => {
  updateBadge();
  removeTabFirstSeen(tabId);
});

chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.settings) restartRemoteSync();
  });
}

updateBadge();
reconcileTabFirstSeen();
restartRemoteSync();
