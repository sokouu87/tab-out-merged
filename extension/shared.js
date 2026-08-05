(function initializeTabOutShared(root) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    logoUrl: '',
    showTabList: true,
    tabListItems: [],
    refreshIntervalSeconds: 30,
    showSystemMemory: false,
    remoteSyncEnabled: false,
    // 用 127.0.0.1 而不是 localhost：Windows 上 localhost 先解析到 IPv6 的 ::1，
  // 而服务只监听 127.0.0.1，走 localhost 会连不上。
  remoteServerUrl: 'http://127.0.0.1:8787',
    extensionKey: '',
  });

  function normalizeSettings(settings) {
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const allowedIntervals = new Set([0, 10, 30, 60]);
    if (!allowedIntervals.has(Number(merged.refreshIntervalSeconds))) {
      merged.refreshIntervalSeconds = DEFAULT_SETTINGS.refreshIntervalSeconds;
    } else {
      merged.refreshIntervalSeconds = Number(merged.refreshIntervalSeconds);
    }
    merged.showSystemMemory = merged.showSystemMemory === true;
    merged.remoteSyncEnabled = merged.remoteSyncEnabled === true;
    merged.remoteServerUrl = String(merged.remoteServerUrl || DEFAULT_SETTINGS.remoteServerUrl).trim();
    merged.extensionKey = String(merged.extensionKey || '').trim();
    return merged;
  }

  async function getSettings(storage = chrome.storage.local) {
    const { settings } = await storage.get('settings');
    return normalizeSettings(settings);
  }

  async function saveSettings(partial, storage = chrome.storage.local) {
    const current = await getSettings(storage);
    const next = normalizeSettings({ ...current, ...partial });
    await storage.set({ settings: next });
    return next;
  }

  async function saveTabForLater(tab, storage = chrome.storage.local) {
    const { deferred = [] } = await storage.get('deferred');
    deferred.push({
      id: Date.now().toString(),
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl || '',
      savedAt: new Date().toISOString(),
      completed: false,
      dismissed: false,
    });
    await storage.set({ deferred });
  }

  root.TabOutShared = {
    DEFAULT_SETTINGS,
    getSettings,
    normalizeSettings,
    saveSettings,
    saveTabForLater,
  };
})(globalThis);
