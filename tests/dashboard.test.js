import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/dom';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { URL } from 'node:url';

const indexPath = new URL('../extension/index.html', import.meta.url);
const appPath = new URL('../extension/app.js', import.meta.url);
const extensionUrl = 'chrome-extension://tab-out-test/index.html';
const gib = 1024 ** 3;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushAsyncWork() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function tab(overrides) {
  return {
    id: overrides.id,
    url: overrides.url,
    title: overrides.title || overrides.url,
    windowId: overrides.windowId || 1,
    active: false,
    audible: false,
    pinned: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    ...overrides,
  };
}

async function loadDashboard({ tabs: initialTabs, deferred = [] }) {
  const html = await readFile(indexPath, 'utf8');
  const appSource = await readFile(appPath, 'utf8');
  const dom = new JSDOM(html, {
    url: extensionUrl,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  dom.window.setTimeout = globalThis.setTimeout;
  dom.window.clearTimeout = globalThis.clearTimeout;
  dom.window.Date = Date;

  let tabs = initialTabs.map(item => ({ ...item }));
  const storage = { deferred };
  const chrome = {
    runtime: { id: 'tab-out-test' },
    tabs: {
      query: vi.fn(async () => tabs.map(item => ({ ...item }))),
      discard: vi.fn(async () => {}),
      remove: vi.fn(async tabIds => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        tabs = tabs.filter(item => !ids.includes(item.id));
      }),
      update: vi.fn(async () => {}),
    },
    windows: {
      getCurrent: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => {}),
    },
    storage: {
      local: {
        get: vi.fn(async key => ({ [key]: storage[key] || [] })),
        set: vi.fn(async patch => Object.assign(storage, patch)),
      },
    },
    system: {
      memory: {
        getInfo: vi.fn(callback => {
          const info = {
            capacity: 16 * gib,
            availableCapacity: 4 * gib,
          };
          if (typeof callback === 'function') {
            callback(info);
            return undefined;
          }
          return Promise.resolve(info);
        }),
      },
    },
  };

  dom.window.chrome = chrome;
  dom.window.console = console;
  dom.window.eval(appSource);
  await flushAsyncWork();

  return {
    chrome,
    document: dom.window.document,
    setTabs(nextTabs) {
      tabs = nextTabs.map(item => ({ ...item }));
    },
  };
}

describe('new tab dashboard seam', () => {
  test('renders grouped tabs, saved tabs, and the system memory snapshot', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-05T12:00:00Z') });
    const { document } = await loadDashboard({
      tabs: [
        tab({ id: 1, url: 'https://alpha.test/article', title: 'Alpha article' }),
        tab({ id: 2, url: 'https://beta.test/home', title: 'Beta home', active: true }),
        tab({ id: 3, url: 'https://music.test/player', title: 'Music player', audible: true }),
        tab({ id: 4, url: 'chrome://settings', title: 'Settings' }),
      ],
      deferred: [
        {
          id: 'saved-1',
          url: 'https://later.test/read',
          title: 'Later reading',
          savedAt: '2026-07-05T11:30:00.000Z',
          completed: false,
          dismissed: false,
        },
      ],
    });

    const page = within(document.body);
    expect(page.getByText('Alpha Test')).toBeTruthy();
    expect(page.getByText('Beta Test')).toBeTruthy();
    expect(page.getByText('Music Test')).toBeTruthy();
    expect(page.getByText('Later reading')).toBeTruthy();
    expect(page.getByText('75.0% used')).toBeTruthy();
    expect(page.getByRole('button', { name: /Sleep 1 inactive tab/i })).toBeTruthy();
  });

  test('sleep actions optimistically keep earlier tabs sleeping across later tab fetches', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-05T12:00:00Z') });
    const { chrome, document } = await loadDashboard({
      tabs: [
        tab({ id: 1, url: 'https://alpha.test/article', title: 'Alpha article' }),
        tab({ id: 2, url: 'https://beta.test/research', title: 'Beta research' }),
        tab({ id: 3, url: 'https://active.test/current', title: 'Active work', active: true }),
      ],
    });
    const page = within(document.body);
    const alphaCard = document.querySelector('[data-domain-id="domain-alpha-test"]');

    fireEvent.click(within(alphaCard).getByRole('button', { name: /Sleep 1 tab/i }));
    await flushAsyncWork();

    const alphaChip = document.querySelector('[data-tab-id="1"]');
    expect(chrome.tabs.discard).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.discard).toHaveBeenLastCalledWith(1);
    expect(alphaChip.classList.contains('is-sleeping-tab')).toBe(true);
    expect(alphaChip.classList.contains('is-freed-tab')).toBe(true);
    expect(alphaChip.querySelector('.chip-state-bar').getAttribute('aria-label')).toMatch(/Freed by Tab Out/i);

    fireEvent.click(page.getByRole('button', { name: /Sleep 1 inactive tab/i }));
    await flushAsyncWork();

    expect(chrome.tabs.discard.mock.calls.map(([tabId]) => tabId)).toEqual([1, 2]);
    expect(alphaChip.classList.contains('is-sleeping-tab')).toBe(true);
    expect(alphaChip.querySelector('.chip-state-bar').getAttribute('aria-label')).toMatch(/Freed by Tab Out/i);

    vi.advanceTimersByTime(6025);
    await flushAsyncWork();

    expect(alphaChip.classList.contains('is-sleeping-tab')).toBe(true);
    expect(alphaChip.classList.contains('is-freed-tab')).toBe(false);
    expect(alphaChip.querySelector('.chip-state-bar').getAttribute('aria-label')).toMatch(/Sleeping tab/i);
  });
});
