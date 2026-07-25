import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { URL } from 'node:url';

const backgroundPath = new URL('../extension/background.js', import.meta.url);

async function flushPromises() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function loadBackgroundWithTabs(initialTabs) {
  const listeners = {};
  let tabs = initialTabs;
  const chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn(listener => { listeners.onInstalled = listener; }) },
      onStartup: { addListener: vi.fn(listener => { listeners.onStartup = listener; }) },
    },
    tabs: {
      query: vi.fn(async () => tabs),
      onCreated: { addListener: vi.fn(listener => { listeners.onCreated = listener; }) },
      onRemoved: { addListener: vi.fn(listener => { listeners.onRemoved = listener; }) },
      onUpdated: { addListener: vi.fn(listener => { listeners.onUpdated = listener; }) },
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
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
