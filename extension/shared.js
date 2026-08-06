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
  const MAX_RECENTLY_CLOSED = 25;

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

  function normalizeRecentlyClosed(items, now = Date.now()) {
    if (!Array.isArray(items)) return [];

    const normalized = [];
    for (const item of items.slice(0, MAX_RECENTLY_CLOSED)) {
      const isWindow = Boolean(item?.window);
      const tabs = isWindow && Array.isArray(item.window.tabs) ? item.window.tabs : [];
      const tab = isWindow ? tabs[0] : item?.tab;
      const sessionId = isWindow ? (item.window.sessionId || tab?.sessionId) : tab?.sessionId;
      if (!tab || typeof sessionId !== 'string' || !sessionId) continue;

      normalized.push({
        sessionId,
        url: tab.url || '',
        title: tab.title || tab.url || '',
        favIconUrl: tab.favIconUrl || '',
        // chrome.sessions reports lastModified in SECONDS, unlike almost every
        // other Chrome API. Using it as-is dated every entry to early 1970 and
        // rendered "20650 days ago" across the whole list.
        closedAt: Number.isFinite(item.lastModified) ? item.lastModified * 1000 : now,
        kind: isWindow ? 'window' : 'tab',
        tabCount: isWindow ? Math.max(tabs.length, 1) : 1,
      });
    }
    return normalized;
  }

  async function getRecentlyClosedSnapshot(sessionsApi = root.chrome?.sessions) {
    if (!sessionsApi || typeof sessionsApi.getRecentlyClosed !== 'function') return [];

    const items = await new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = value => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(Array.isArray(value) ? value : []);
      };
      timer = setTimeout(() => finish([]), 1500);

      try {
        const result = sessionsApi.getRecentlyClosed({ maxResults: MAX_RECENTLY_CLOSED }, value => {
          let failed = false;
          try { failed = Boolean(root.chrome?.runtime?.lastError); } catch {}
          finish(failed ? [] : value);
        });
        if (result && typeof result.then === 'function') result.then(finish).catch(() => finish([]));
      } catch {
        finish([]);
      }
    });

    return normalizeRecentlyClosed(items);
  }

  root.TabOutShared = {
    DEFAULT_SETTINGS,
    MAX_RECENTLY_CLOSED,
    getSettings,
    getRecentlyClosedSnapshot,
    normalizeSettings,
    normalizeRecentlyClosed,
    saveSettings,
    saveTabForLater,
  };
})(globalThis);
