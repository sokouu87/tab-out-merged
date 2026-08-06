import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, within } from '@testing-library/dom';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { URL } from 'node:url';

const indexPath = new URL('../extension/index.html', import.meta.url);
const sharedPath = new URL('../extension/shared.js', import.meta.url);
const appPath = new URL('../extension/app.js', import.meta.url);
const extensionUrl = 'chrome-extension://tab-out-test/index.html';
const gib = 1024 ** 3;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushAsyncWork() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
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

async function loadDashboard({ tabs: initialTabs, deferred = [], recentlyClosed = [], settings = {} }) {
  const html = await readFile(indexPath, 'utf8');
  const sharedSource = await readFile(sharedPath, 'utf8');
  const appSource = await readFile(appPath, 'utf8');
  const dom = new JSDOM(html, {
    url: extensionUrl,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  dom.window.setTimeout = globalThis.setTimeout;
  dom.window.clearTimeout = globalThis.clearTimeout;
  dom.window.Date = Date;

  const audioContext = vi.fn(function FakeAudioContext() {
    const connect = destination => destination;
    return {
      currentTime: 0,
      sampleRate: 48_000,
      destination: {},
      createBuffer: vi.fn((channels, length) => ({
        getChannelData: () => new Float32Array(length),
      })),
      createBufferSource: vi.fn(() => ({ connect, start: vi.fn() })),
      createBiquadFilter: vi.fn(() => ({
        connect,
        Q: { value: 0 },
        frequency: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      })),
      createGain: vi.fn(() => ({
        connect,
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      })),
      close: vi.fn(),
    };
  });
  const requestAnimationFrame = vi.fn(() => 1);
  dom.window.AudioContext = audioContext;
  dom.window.requestAnimationFrame = requestAnimationFrame;

  let tabs = initialTabs.map(item => ({ ...item }));
  let closedSessions = recentlyClosed.map(item => structuredClone(item));
  const storage = { deferred, settings };
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
    sessions: {
      getRecentlyClosed: vi.fn((options, callback) => {
        const result = closedSessions.map(item => structuredClone(item));
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      }),
      restore: vi.fn(async sessionId => {
        closedSessions = closedSessions.filter(item => {
          return item.tab?.sessionId !== sessionId && item.window?.sessionId !== sessionId;
        });
      }),
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
  dom.window.eval(sharedSource);
  dom.window.eval(appSource);
  await flushAsyncWork();

  return {
    chrome,
    document: dom.window.document,
    window: dom.window,
    effects: {
      audioContext,
      requestAnimationFrame,
      reset() {
        audioContext.mockClear();
        requestAnimationFrame.mockClear();
      },
    },
    setTabs(nextTabs) {
      tabs = nextTabs.map(item => ({ ...item }));
    },
  };
}

describe('new tab dashboard seam', () => {
  test('减少动画默认开启，设置开关默认勾选', async () => {
    const { document, window } = await loadDashboard({
      tabs: [tab({ id: 1, url: 'https://alpha.test/article', title: 'Alpha article' })],
    });

    expect(window.TabOutShared.DEFAULT_SETTINGS.reduceMotion).toBe(true);
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true);

    fireEvent.click(document.getElementById('settingsBtn'));
    await flushAsyncWork();

    const toggle = document.getElementById('reduceMotionToggle');
    expect(toggle.checked).toBe(true);

    toggle.checked = false;
    fireEvent.change(toggle);
    await flushAsyncWork();
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false);

    toggle.checked = true;
    fireEvent.change(toggle);
    await flushAsyncWork();
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true);
  });

  test('减少动画开启时，关闭最后一个标签不播放效果并从 DOM 移除卡片', async () => {
    vi.useFakeTimers();
    const { chrome, document, effects } = await loadDashboard({
      tabs: [tab({ id: 1, url: 'https://alpha.test/article', title: 'Alpha article' })],
    });
    const card = document.querySelector('[data-domain-id="domain-alpha-test"]');
    effects.reset();

    fireEvent.click(within(card).getByTitle('Close this tab'));
    await flushAsyncWork();
    vi.advanceTimersByTime(200);
    await flushAsyncWork();

    expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
    expect(effects.audioContext).not.toHaveBeenCalled();
    expect(effects.requestAnimationFrame).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[style*="z-index: 9999"]')).toHaveLength(0);
    expect(document.body.contains(card)).toBe(false);
  });

  test('关闭减少动画后，关闭标签恢复彩带和音效', async () => {
    vi.useFakeTimers();
    const { document, effects } = await loadDashboard({
      tabs: [tab({ id: 1, url: 'https://alpha.test/article', title: 'Alpha article' })],
      settings: { reduceMotion: false },
    });
    const card = document.querySelector('[data-domain-id="domain-alpha-test"]');
    effects.reset();

    fireEvent.click(within(card).getByTitle('Close this tab'));
    await flushAsyncWork();

    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false);
    expect(effects.audioContext).toHaveBeenCalledTimes(1);
    expect(effects.requestAnimationFrame).toHaveBeenCalledTimes(17);
    expect(document.querySelectorAll('[style*="z-index: 9999"]')).toHaveLength(17);
  });

  test('renders grouped tabs, saved tabs, and the enabled system memory snapshot', async () => {
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
      settings: { showSystemMemory: true },
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
    expect(document.getElementById('systemMemoryPanel').style.display).toBe('none');
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

  test('最近关闭显示在 Saved 下方，点击后恢复并刷新列表', async () => {
    const { chrome, document } = await loadDashboard({
      tabs: [tab({ id: 1, url: 'https://open.test', title: 'Open' })],
      deferred: [{
        id: 'saved-1',
        url: 'https://saved.test',
        title: 'Saved item',
        savedAt: new Date().toISOString(),
        completed: false,
        dismissed: false,
      }],
      recentlyClosed: [
        {
          lastModified: Date.now() - 1_000,
          tab: {
            sessionId: 'restore-one',
            url: 'https://closed-one.test',
            title: 'Closed one',
            favIconUrl: '',
          },
        },
        {
          lastModified: Date.now() - 2_000,
          tab: {
            sessionId: 'restore-two',
            url: 'https://closed-two.test',
            title: 'Closed two',
            favIconUrl: '',
          },
        },
      ],
    });

    // Recently closed leads the left column, above Open tabs — not in the right
    // column, where its fixed-height scroll box sat beside that column's own
    // scrollbar.
    const column = document.getElementById('deferredColumn');
    expect(Array.from(column.children).map(element => element.id)).toEqual(['deferredSavedSection']);

    const openTabsSection = document.getElementById('openTabsSection');
    const recentlyClosed = document.getElementById('recentlyClosedDesktopSection');
    expect(openTabsSection.firstElementChild.id).toBe('recentlyClosedDesktopSection');

    expect(document.getElementById('recentlyClosedDesktopCount').textContent).toBe('2 items');
    expect(document.querySelectorAll('#recentlyClosedDesktopList .recently-closed-item')).toHaveLength(2);
    // Two entries fit inside the 3x3 block, so there is nothing to expand.
    expect(document.getElementById('recentlyClosedToggle').style.display).toBe('none');

    fireEvent.click(within(recentlyClosed).getByRole('button', { name: 'Restore Closed one' }));
    await flushAsyncWork();

    expect(chrome.sessions.restore).toHaveBeenCalledWith('restore-one');
    expect(document.querySelectorAll('#recentlyClosedDesktopList .recently-closed-item')).toHaveLength(1);
  });

  test('超过 3x3 的部分折叠起来，点击后展开', async () => {
    const { document } = await loadDashboard({
      tabs: [tab({ id: 1, url: 'https://open.test', title: 'Open' })],
      recentlyClosed: Array.from({ length: 12 }, (_, index) => ({
        lastModified: Date.now() - index * 1_000,
        tab: {
          sessionId: `restore-${index}`,
          url: `https://closed-${index}.test`,
          title: `Closed ${index}`,
          favIconUrl: '',
        },
      })),
    });

    const list = document.getElementById('recentlyClosedDesktopList');
    const toggle = document.getElementById('recentlyClosedToggle');

    // All 12 are in the DOM; CSS hides everything past the ninth until expanded,
    // so the toggle only has to advertise the remainder.
    expect(list.children).toHaveLength(12);
    expect(list.classList.contains('is-expanded')).toBe(false);
    expect(toggle.style.display).toBe('inline-block');
    expect(toggle.textContent).toBe('Show 3 more');
    // Lives in the header beside the count, not as a row under the list.
    expect(toggle.parentElement.classList.contains('section-header')).toBe(true);

    fireEvent.click(toggle);
    expect(list.classList.contains('is-expanded')).toBe(true);
    expect(toggle.textContent).toBe('Show less');

    fireEvent.click(toggle);
    expect(list.classList.contains('is-expanded')).toBe(false);
    expect(toggle.textContent).toBe('Show 3 more');
  });
});
