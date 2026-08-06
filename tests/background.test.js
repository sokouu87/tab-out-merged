import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { URL } from 'node:url';

const backgroundPath = new URL('../extension/background.js', import.meta.url);
const sharedPath = new URL('../extension/shared.js', import.meta.url);

async function flushPromises() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

const EXTENSION_ORIGIN = 'chrome-extension://test-extension-id';
const DASHBOARD_URL = `${EXTENSION_ORIGIN}/index.html`;

async function loadBackgroundWithTabs(initialTabs, {
  existingDashboardTabs = [],
  initialStorage = {},
  recentlyClosed = [],
  sessionsError = null,
} = {}) {
  const listeners = {};
  let tabs = initialTabs;
  let dashboardTabs = existingDashboardTabs;
  const storage = { ...initialStorage };
  const chrome = {
    runtime: {
      lastError: null,
      onInstalled: { addListener: vi.fn(listener => { listeners.onInstalled = listener; }) },
      onStartup: { addListener: vi.fn(listener => { listeners.onStartup = listener; }) },
      getURL: vi.fn(path => `${EXTENSION_ORIGIN}/${path}`),
    },
    tabs: {
      // A url filter means "find the dashboard"; no filter means "count everything"
      query: vi.fn(async (queryInfo = {}) => (queryInfo.url ? dashboardTabs : tabs)),
      create: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      get: vi.fn(async tabId => tabs.find(tab => tab.id === tabId)),
      onCreated: { addListener: vi.fn(listener => { listeners.onCreated = listener; }) },
      onRemoved: { addListener: vi.fn(listener => { listeners.onRemoved = listener; }) },
      onUpdated: { addListener: vi.fn(listener => { listeners.onUpdated = listener; }) },
    },
    windows: {
      update: vi.fn(async () => {}),
    },
    sessions: {
      getRecentlyClosed: vi.fn(async () => {
        if (sessionsError) throw sessionsError;
        return recentlyClosed;
      }),
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      onClicked: { addListener: vi.fn(listener => { listeners.onClicked = listener; }) },
    },
    storage: {
      local: {
        get: vi.fn(async keys => {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map(key => [key, storage[key]]));
        }),
        set: vi.fn(async patch => Object.assign(storage, patch)),
      },
      onChanged: { addListener: vi.fn(listener => { listeners.onStorageChanged = listener; }) },
    },
  };

  const [sharedSource, source] = await Promise.all([
    readFile(sharedPath, 'utf8'),
    readFile(backgroundPath, 'utf8'),
  ]);
  const context = { chrome, console, setTimeout, clearTimeout, URL };
  vm.runInNewContext(sharedSource, context);
  vm.runInNewContext(source, context);
  await flushPromises();

  return {
    chrome,
    listeners,
    storage,
    buildSnapshot: context.buildSnapshot,
    setTabs(nextTabs) {
      tabs = nextTabs;
    },
    setDashboardTabs(nextDashboardTabs) {
      dashboardTabs = nextDashboardTabs;
    },
  };
}

function webTab(id) {
  return { id, url: `https://example-${id}.test/page` };
}

describe('background badge seam', () => {
  test('shows the count and workload color for real web tabs only', async () => {
    const tabs = [
      ...Array.from({ length: 11 }, (_, index) => webTab(index + 1)),
      { id: 20, url: 'chrome://settings' },
      { id: 21, url: 'chrome-extension://extension-id/index.html' },
      { id: 22, url: 'about:blank' },
      { id: 23, url: 'edge://extensions' },
      { id: 24, url: 'brave://settings' },
    ];

    const { chrome } = await loadBackgroundWithTabs(tabs);

    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '11' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ color: '#b8892e' });
  });

  test('refreshes the badge when Chrome tab events fire', async () => {
    const harness = await loadBackgroundWithTabs([webTab(1)]);
    harness.setTabs([webTab(1), webTab(2), webTab(3)]);

    harness.listeners.onCreated();
    await flushPromises();

    expect(harness.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '3' });
    expect(harness.chrome.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ color: '#3d7a4a' });
  });

  test('clears the badge when no real web tabs are open', async () => {
    const { chrome } = await loadBackgroundWithTabs([{ id: 1, url: 'chrome://newtab/' }]);

    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    expect(chrome.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });
});

describe('tab first-seen tracking', () => {
  test('启动时补齐当前标签并清理失效 tabId', async () => {
    const harness = await loadBackgroundWithTabs([webTab(1), webTab(2)], {
      initialStorage: { tabFirstSeen: { 1: 1234, 99: 5678 } },
    });

    expect(harness.storage.tabFirstSeen['1']).toBe(1234);
    expect(harness.storage.tabFirstSeen['2']).toEqual(expect.any(Number));
    expect(harness.storage.tabFirstSeen['99']).toBeUndefined();

    harness.listeners.onCreated(webTab(3));
    harness.listeners.onRemoved(1);
    await flushPromises();

    expect(harness.storage.tabFirstSeen['3']).toEqual(expect.any(Number));
    expect(harness.storage.tabFirstSeen['1']).toBeUndefined();
  });
});

describe('recently closed snapshot seam', () => {
  test('归一化普通标签和关闭窗口首标签，并把查询限制为 25 条', async () => {
    // chrome.sessions reports lastModified in SECONDS. Feeding the mock a
    // millisecond value would let a broken conversion pass unnoticed — which is
    // exactly what happened: every entry rendered as "20650 days ago".
    const closedAtMs = Date.UTC(2026, 7, 6, 9, 0, 0);
    const lastModifiedSeconds = Math.floor(closedAtMs / 1000);
    const harness = await loadBackgroundWithTabs([webTab(1)], {
      recentlyClosed: [
        {
          lastModified: lastModifiedSeconds,
          tab: {
            sessionId: 'tab-session',
            url: 'https://single.example/article',
            title: '单个标签',
            favIconUrl: 'https://single.example/favicon.ico',
          },
        },
        {
          lastModified: lastModifiedSeconds - 1,
          window: {
            sessionId: 'window-session',
            tabs: [
              { url: 'https://window.example/first', title: '窗口首标签', favIconUrl: '' },
              { url: 'https://window.example/second', title: '窗口第二个标签', favIconUrl: '' },
            ],
          },
        },
      ],
    });

    const snapshot = await harness.buildSnapshot();

    expect(harness.chrome.sessions.getRecentlyClosed).toHaveBeenCalledWith(
      { maxResults: 25 },
      expect.any(Function),
    );
    expect(snapshot.recentlyClosed).toEqual([
      {
        sessionId: 'tab-session',
        url: 'https://single.example/article',
        title: '单个标签',
        favIconUrl: 'https://single.example/favicon.ico',
        closedAt: closedAtMs,
        kind: 'tab',
        tabCount: 1,
      },
      {
        sessionId: 'window-session',
        url: 'https://window.example/first',
        title: '窗口首标签',
        favIconUrl: '',
        closedAt: closedAtMs - 1_000,
        kind: 'window',
        tabCount: 2,
      },
    ]);
  });

  test('sessions API 抛错时降级为空数组而不阻断快照', async () => {
    const harness = await loadBackgroundWithTabs([webTab(1)], {
      sessionsError: new Error('Vivaldi sessions unavailable'),
    });

    await expect(harness.buildSnapshot()).resolves.toMatchObject({ recentlyClosed: [] });
  });
});

describe('toolbar action seam', () => {
  test('registers an onClicked listener so the icon is not inert', async () => {
    const { chrome } = await loadBackgroundWithTabs([webTab(1)]);

    expect(chrome.action.onClicked.addListener).toHaveBeenCalledTimes(1);
  });

  test('opens the dashboard by absolute URL when none is open yet', async () => {
    const harness = await loadBackgroundWithTabs([webTab(1)]);

    harness.listeners.onClicked();
    await flushPromises();

    // Absolute extension URL, not a blank new tab — the newtab override is not
    // honoured on every Chromium browser (e.g. Vivaldi keeps its Speed Dial).
    expect(harness.chrome.tabs.create).toHaveBeenCalledWith({ url: DASHBOARD_URL });
    expect(harness.chrome.tabs.update).not.toHaveBeenCalled();
  });

  test('focuses the existing dashboard tab instead of opening a duplicate', async () => {
    const harness = await loadBackgroundWithTabs([webTab(1)], {
      existingDashboardTabs: [{ id: 42, windowId: 7, url: DASHBOARD_URL }],
    });

    harness.listeners.onClicked();
    await flushPromises();

    expect(harness.chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(harness.chrome.windows.update).toHaveBeenCalledWith(7, { focused: true });
    expect(harness.chrome.tabs.create).not.toHaveBeenCalled();
  });
});
