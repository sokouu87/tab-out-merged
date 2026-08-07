import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { URL } from 'node:url';

const mobilePath = new URL('../server/mobile.html', import.meta.url);

async function flushAsyncWork() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

async function loadMobile(shortcutCount, state = {}) {
  const html = await readFile(mobilePath, 'utf8');
  const shortcuts = Array.from({ length: shortcutCount }, (_, position) => ({
    url: `https://shortcut-${position}.example`,
    title: `快捷方式 ${position + 1}`,
    position,
  }));
  const dom = new JSDOM(html, {
    url: 'https://tab.example/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.setInterval = vi.fn(() => 0);
      window.fetch = vi.fn(async url => ({
        ok: true,
        status: 200,
        json: async () => String(url).includes('/api/shortcuts')
          ? shortcuts
          : {
            tabs: [],
            saved: [],
            recentlyClosed: [],
            lastSyncTs: null,
            online: false,
            pendingCount: 0,
            ...state,
          },
      }));
    },
  });
  await flushAsyncWork();
  return dom;
}

describe('移动端快捷方式布局', () => {
  test.each([
    [0, { slotCount: 1, rowCount: 1, showAdd: true }],
    [4, { slotCount: 5, rowCount: 1, showAdd: true }],
    [5, { slotCount: 6, rowCount: 2, showAdd: true }],
    [10, { slotCount: 10, rowCount: 2, showAdd: false }],
  ])('%i 个快捷方式使用预期格子数、行数和加号状态', async (count, expected) => {
    const dom = await loadMobile(count);

    expect(dom.window.getShortcutGridLayout(count)).toEqual(expected);
    const grid = dom.window.document.getElementById('shortcutGrid');
    expect(grid.children).toHaveLength(expected.slotCount);
    expect(grid.dataset.rows).toBe(String(expected.rowCount));
    expect(grid.querySelectorAll('.shortcut-add')).toHaveLength(expected.showAdd ? 1 : 0);

    dom.window.close();
  });
});

describe('移动端最近关闭与稍后再看', () => {
  test('区块顺序固定，两个列表默认只显示前 5 条并可展开收起', async () => {
    const recentlyClosed = Array.from({ length: 7 }, (_, index) => ({
      sessionId: `recent-${index}`,
      url: `https://recent-${index}.example/article`,
      title: `最近关闭 ${index + 1}`,
      favIconUrl: '',
      closedAt: Date.now() - index * 1_000,
      kind: 'tab',
      tabCount: 1,
    }));
    const saved = Array.from({ length: 6 }, (_, index) => ({
      id: `saved-${index}`,
      url: `https://saved-${index}.example/article`,
      title: `稍后再看 ${index + 1}`,
      savedAt: new Date().toISOString(),
      completed: false,
      dismissed: false,
    }));
    const dom = await loadMobile(0, { recentlyClosed, saved });
    const document = dom.window.document;

    // 手机端把最近关闭放在最后，首屏留给快捷方式和还开着的标签。
    // 桌面端顺序相反（见 dashboard.test.js），两边是各自独立的页面。
    expect(Array.from(document.querySelectorAll(
      '#shortcutPanel, #recentlyClosedSection, #savedSection, #openTabsSection',
    )).map(element => element.id)).toEqual([
      'shortcutPanel',
      'savedSection',
      'openTabsSection',
      'recentlyClosedSection',
    ]);
    expect(document.getElementById('recentlyClosedCount').textContent).toBe('7');
    expect(document.getElementById('savedCount').textContent).toBe('6');
    expect(document.querySelectorAll('#recentlyClosedList .tab-row')).toHaveLength(5);
    expect(document.querySelectorAll('#savedList .tab-row')).toHaveLength(5);
    expect(document.getElementById('recentlyClosedToggle').hidden).toBe(false);
    expect(document.getElementById('savedToggle').hidden).toBe(false);
    expect(document.querySelector('#recentlyClosedList a').target).toBe('_blank');

    document.getElementById('recentlyClosedToggle').click();
    document.getElementById('savedToggle').click();
    expect(document.querySelectorAll('#recentlyClosedList .tab-row')).toHaveLength(7);
    expect(document.querySelectorAll('#savedList .tab-row')).toHaveLength(6);
    expect(document.getElementById('recentlyClosedToggle').textContent).toBe('收起');

    document.getElementById('recentlyClosedToggle').click();
    expect(document.querySelectorAll('#recentlyClosedList .tab-row')).toHaveLength(5);
    dom.window.close();
  });

  test('不超过 5 条时不显示展开控件', async () => {
    const dom = await loadMobile(0, {
      recentlyClosed: [{ sessionId: 'one', url: 'https://one.example', title: 'One', closedAt: Date.now() }],
      saved: [{ id: 'one', url: 'https://saved.example', title: 'Saved', completed: false, dismissed: false }],
    });

    expect(dom.window.document.getElementById('recentlyClosedToggle').hidden).toBe(true);
    expect(dom.window.document.getElementById('savedToggle').hidden).toBe(true);
    dom.window.close();
  });
});
