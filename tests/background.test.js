import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { URL } from 'node:url';

const backgroundPath = new URL('../extension/background.js', import.meta.url);

async function flushPromises() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const EXTENSION_ORIGIN = 'chrome-extension://test-extension-id';
const DASHBOARD_URL = `${EXTENSION_ORIGIN}/index.html`;

async function loadBackgroundWithTabs(initialTabs, { existingDashboardTabs = [] } = {}) {
  const listeners = {};
  let tabs = initialTabs;
  let dashboardTabs = existingDashboardTabs;
  const chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn(listener => { listeners.onInstalled = listener; }) },
      onStartup: { addListener: vi.fn(listener => { listeners.onStartup = listener; }) },
      getURL: vi.fn(path => `${EXTENSION_ORIGIN}/${path}`),
    },
    tabs: {
      // A url filter means "find the dashboard"; no filter means "count everything"
      query: vi.fn(async (queryInfo = {}) => (queryInfo.url ? dashboardTabs : tabs)),
      create: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      onCreated: { addListener: vi.fn(listener => { listeners.onCreated = listener; }) },
      onRemoved: { addListener: vi.fn(listener => { listeners.onRemoved = listener; }) },
      onUpdated: { addListener: vi.fn(listener => { listeners.onUpdated = listener; }) },
    },
    windows: {
      update: vi.fn(async () => {}),
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      onClicked: { addListener: vi.fn(listener => { listeners.onClicked = listener; }) },
    },
  };

  const source = await readFile(backgroundPath, 'utf8');
  vm.runInNewContext(source, { chrome, console });
  await flushPromises();

  return {
    chrome,
    listeners,
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
