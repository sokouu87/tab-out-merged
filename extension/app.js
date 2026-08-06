/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
const FREED_FEEDBACK_MS = 6000;
const optimisticSleepingTabIds = new Set();
const freedFeedbackUntilByTabId = new Map();
let freedFeedbackTimer = null;

// Chrome tab groups — populated by fetchTabGroups()
let tabGroupsList = [];

function hasFreedFeedback(tabId, now = Date.now()) {
  const feedbackUntil = freedFeedbackUntilByTabId.get(tabId);
  return typeof feedbackUntil === 'number' && feedbackUntil > now;
}

function pruneExpiredFreedFeedback(now = Date.now()) {
  for (const [tabId, feedbackUntil] of freedFeedbackUntilByTabId) {
    if (feedbackUntil <= now) freedFeedbackUntilByTabId.delete(tabId);
  }
}

function syncOpenTabFeedbackFlags(now = Date.now()) {
  openTabs = openTabs.map(tab => {
    const freedByTabOut = Boolean(tab.discarded && hasFreedFeedback(tab.id, now));
    return tab.freedByTabOut === freedByTabOut ? tab : { ...tab, freedByTabOut };
  });
}

function scheduleFreedFeedbackCleanup() {
  if (freedFeedbackTimer) {
    clearTimeout(freedFeedbackTimer);
    freedFeedbackTimer = null;
  }

  const now = Date.now();
  pruneExpiredFreedFeedback(now);

  let nextFeedbackUntil = Infinity;
  for (const feedbackUntil of freedFeedbackUntilByTabId.values()) {
    if (feedbackUntil > now) nextFeedbackUntil = Math.min(nextFeedbackUntil, feedbackUntil);
  }

  if (!Number.isFinite(nextFeedbackUntil)) return;

  freedFeedbackTimer = setTimeout(() => {
    freedFeedbackTimer = null;
    pruneExpiredFreedFeedback();
    syncOpenTabFeedbackFlags();
    updateVisibleTabStates();
    scheduleFreedFeedbackCleanup();
  }, Math.max(nextFeedbackUntil - now, 0) + 25);
}

function reconcileSleepTracking(chromeTabs, now = Date.now()) {
  const tabIds = new Set(chromeTabs.map(tab => tab.id).filter(id => id != null));

  for (const tabId of optimisticSleepingTabIds) {
    if (!tabIds.has(tabId)) optimisticSleepingTabIds.delete(tabId);
  }

  for (const tabId of freedFeedbackUntilByTabId.keys()) {
    if (!tabIds.has(tabId)) freedFeedbackUntilByTabId.delete(tabId);
  }

  pruneExpiredFreedFeedback(now);

  for (const tab of chromeTabs) {
    if (tab.id == null) continue;

    if (tab.discarded) {
      optimisticSleepingTabIds.delete(tab.id);
      continue;
    }

    if (tab.active) {
      optimisticSleepingTabIds.delete(tab.id);
      freedFeedbackUntilByTabId.delete(tab.id);
    }
  }
}

function hasSystemMemoryApi() {
  return (
    typeof chrome !== 'undefined' &&
    chrome.system &&
    chrome.system.memory &&
    typeof chrome.system.memory.getInfo === 'function'
  );
}

async function getSystemMemoryInfo() {
  if (!hasSystemMemoryApi()) return null;

  return new Promise(resolve => {
    let settled = false;
    const finish = info => {
      if (settled) return;
      settled = true;
      resolve(info || null);
    };

    setTimeout(() => finish(null), 1500);

    try {
      const maybePromise = chrome.system.memory.getInfo(finish);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(finish).catch(() => finish(null));
      }
    } catch {
      try {
        const maybePromise = chrome.system.memory.getInfo();
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(finish).catch(() => finish(null));
          return;
        }
      } catch {}
      finish(null);
    }
  });
}

function normalizeSystemMemoryInfo(info) {
  if (!info) return null;

  const capacity = Number(info.capacity);
  const availableCapacity = Number(info.availableCapacity);
  if (!Number.isFinite(capacity) || !Number.isFinite(availableCapacity) || capacity <= 0) {
    return null;
  }

  const usedCapacity = Math.max(capacity - availableCapacity, 0);
  return {
    capacity,
    availableCapacity,
    usedCapacity,
    usedPercent: Math.min((usedCapacity / capacity) * 100, 100),
  };
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    // Count tabs per window to detect standalone windows.
    const tabsPerWindow = {};
    for (const t of tabs) tabsPerWindow[t.windowId] = (tabsPerWindow[t.windowId] || 0) + 1;

    const now = Date.now();
    reconcileSleepTracking(tabs, now);
    openTabs = tabs.map(t => {
      const discarded = Boolean(t.discarded || optimisticSleepingTabIds.has(t.id));
      return {
        id:              t.id,
        url:             t.url,
        title:           t.title,
        windowId:        t.windowId,
        active:          t.active,
        groupId:         t.groupId, // -1 = ungrouped, >= 0 = Chrome tab group id
        audible:         t.audible,
        pinned:          t.pinned,
        isAloneInWindow: tabsPerWindow[t.windowId] === 1,
        discarded,
        frozen:          t.frozen,
        autoDiscardable: t.autoDiscardable,
        freedByTabOut:   Boolean(discarded && hasFreedFeedback(t.id, now)),
        // Flag Tab Out's own pages so we can detect duplicate new tabs
        isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
      };
    });
    scheduleFreedFeedbackCleanup();
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
    optimisticSleepingTabIds.clear();
    freedFeedbackUntilByTabId.clear();
    scheduleFreedFeedbackCleanup();
  }
}

/**
 * isProtectedTab(tab)
 *
 * Returns true for tabs that should never be bulk-closed:
 * - Pinned tabs (Chrome protects these from accidental close)
 * - Tabs that are the sole tab in their window (closing would close the window)
 */
function isProtectedTab(tab) {
  return tab.pinned || tab.isAloneInWindow;
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  // Count tabs per window so we can skip lone-window tabs
  const allTabs = await chrome.tabs.query({});
  const tabsPerWindow = {};
  for (const t of allTabs) tabsPerWindow[t.windowId] = (tabsPerWindow[t.windowId] || 0) + 1;

  const toClose = allTabs
    .filter(tab => {
      if (tab.pinned) return false;
      if (tabsPerWindow[tab.windowId] === 1) return false;
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const tabsPerWindow = {};
  for (const t of allTabs) tabsPerWindow[t.windowId] = (tabsPerWindow[t.windowId] || 0) + 1;
  const toClose = allTabs
    .filter(t => urlSet.has(t.url) && !t.pinned && tabsPerWindow[t.windowId] !== 1)
    .map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsByIds(ids)
 *
 * Closes tabs by their numeric tab ids. Used for closing all tabs
 * in a Chrome tab group (which are identified by tab id, not URL).
 */
async function closeTabsByIds(ids) {
  if (!ids || ids.length === 0) return;
  // Filter out protected tabs (pinned or alone in their window)
  const safeIds = openTabs
    .filter(t => ids.includes(t.id) && !isProtectedTab(t))
    .map(t => t.id);
  if (safeIds.length > 0) await chrome.tabs.remove(safeIds);
  await fetchOpenTabs();
}

/**
 * loadViewMode()
 *
 * Reads the user's preferred view mode from chrome.storage.local.
 * Returns 'group' if Chrome tab groups exist, otherwise 'domain'.
 */
async function loadViewMode() {
  const { viewMode } = await chrome.storage.local.get('viewMode');
  return viewMode || 'group';
}

/**
 * saveViewMode(mode)
 *
 * Persists the user's preferred view mode to chrome.storage.local.
 */
async function saveViewMode(mode) {
  try { await chrome.storage.local.set({ viewMode: mode }); } catch { /* ignore */ }
}

/**
 * fetchTabGroups()
 *
 * Reads all Chrome tab groups via the tabGroups API.
 * Populates the module-level tabGroupsList array.
 */
async function fetchTabGroups() {
  try {
    const groups = await chrome.tabGroups.query({});
    tabGroupsList = groups;
  } catch {
    // tabGroups API unavailable (permission denied or not supported)
    tabGroupsList = [];
  }
}

/**
 * detectDuplicateTabs(tabs)
 *
 * Analyzes a tab array for duplicate URLs.
 * Returns { urlCounts, uniqueTabs, hasDupes, totalExtras, dupeUrls }.
 */
function detectDuplicateTabs(tabs) {
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }
  return { urlCounts, uniqueTabs, hasDupes, totalExtras, dupeUrls };
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

function canFreeMemoryFromTab(tab) {
  return Boolean(
    tab &&
    tab.id != null &&
    !tab.active &&
    !tab.discarded &&
    tab.autoDiscardable !== false &&
    !tab.audible &&
    !tab.pinned
  );
}

function getFreeMemoryCandidates(tabs) {
  return (tabs || []).filter(canFreeMemoryFromTab);
}

function markTabsAsSleeping(tabIds) {
  const now = Date.now();
  openTabs = openTabs.map(tab => {
    if (!tabIds.has(tab.id)) return tab;
    return {
      ...tab,
      discarded: true,
      freedByTabOut: hasFreedFeedback(tab.id, now),
    };
  });
}

async function discardTabsInBackground(tabIds) {
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.discard(tabId);
    } catch (err) {
      console.warn('[tab-out] Could not discard tab:', tabId, err);
    }
  }
}

function sleepTabsOptimistically(tabs) {
  const candidates = getFreeMemoryCandidates(tabs);
  const candidateIds = new Set(candidates.map(tab => tab.id));
  const feedbackUntil = Date.now() + FREED_FEEDBACK_MS;

  for (const tabId of candidateIds) {
    optimisticSleepingTabIds.add(tabId);
    freedFeedbackUntilByTabId.set(tabId, feedbackUntil);
  }

  markTabsAsSleeping(candidateIds);
  scheduleFreedFeedbackCleanup();
  void discardTabsInBackground(candidateIds);

  return {
    candidates: candidates.length,
    slept: candidates.length,
  };
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  await TabOutShared.saveTabForLater(tab);
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  // Also check actual tab data — DOM cards may be animating out while real tabs still exist
  const realTabsRemaining = openTabs.filter(t => !isProtectedTab(t)).length;
  if (realTabsRemaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  sleep:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" /></svg>`,
};


/* ----------------------------------------------------------------
   CUSTOM LOGO AND NAV LIST SETTINGS
   ---------------------------------------------------------------- */
const DEFAULT_SETTINGS = TabOutShared.DEFAULT_SETTINGS;

async function getSettings() {
  try {
    return await TabOutShared.getSettings();
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(partial) {
  try {
    return await TabOutShared.saveSettings(partial);
  } catch (err) {
    console.warn('[tab-out] Failed to save settings:', err);
    return null;
  }
}

function parseTabListItems(rawText) {
  if (!rawText) return [];
  return rawText
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)
    .map(url => {
      try {
        const parsed = new URL(url);
        return { url, title: parsed.hostname.replace(/^www\./, '') || url };
      } catch {
        return { url, title: url };
      }
    });
}

function tabListItemsToText(items) {
  return Array.isArray(items) ? items.map(item => item.url).filter(Boolean).join('\n') : '';
}

let navListResizeBound = false;
let navListExpanded = false;

async function renderTabList() {
  const section = document.getElementById('tabListSection');
  const container = document.getElementById('tabListContainer');
  if (!section || !container) return;

  const settings = await getSettings();
  const items = Array.isArray(settings.tabListItems) ? settings.tabListItems : [];
  if (!settings.showTabList || items.length === 0) {
    section.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  let html = items.map(item => {
    let hostname = '';
    try { hostname = new URL(item.url).hostname; } catch {}
    const faviconUrl = hostname ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=16` : '';
    const safeUrl = escapeHtml(item.url || '');
    const safeTitle = escapeHtml(item.title || item.url || '');
    return `<a href="${safeUrl}" target="_blank" rel="noopener" class="tab-list-chip" title="${safeTitle}">
      ${faviconUrl ? `<span class="chip-favicon" style="background-image:url('${faviconUrl}')" aria-hidden="true"></span>` : ''}
      <span class="chip-text">${safeTitle}</span>
    </a>`;
  }).join('');
  html += `<button class="tab-list-more" id="tabListMore" type="button" aria-label="Show all shortcuts" title="Show all shortcuts" style="display:none">More</button>`;
  container.innerHTML = html;

  const moreButton = document.getElementById('tabListMore');
  if (moreButton) {
    moreButton.addEventListener('click', () => {
      navListExpanded = !navListExpanded;
      reflowNavList();
    });
  }

  requestAnimationFrame(reflowNavList);
  if (!navListResizeBound) {
    navListResizeBound = true;
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        navListExpanded = false;
        reflowNavList();
      }, 100);
    });
  }
}

function reflowNavList() {
  const container = document.getElementById('tabListContainer');
  const moreButton = document.getElementById('tabListMore');
  if (!container || !moreButton) return;

  const chips = Array.from(container.querySelectorAll('.tab-list-chip'));
  if (chips.length === 0) {
    moreButton.style.display = 'none';
    container.classList.remove('expanded');
    return;
  }

  if (navListExpanded) {
    container.classList.add('expanded');
    chips.forEach(chip => { chip.style.display = 'inline-flex'; });
    moreButton.style.display = 'inline-flex';
    moreButton.textContent = 'Less';
    return;
  }

  container.classList.remove('expanded');
  moreButton.textContent = 'More';
  chips.forEach(chip => { chip.style.display = 'inline-flex'; });
  moreButton.style.display = 'none';
  void container.offsetHeight;

  const containerWidth = container.getBoundingClientRect().width - 8;
  const gap = 8;
  let totalWidth = 0;
  let visibleCount = 0;
  for (let index = 0; index < chips.length; index++) {
    totalWidth += chips[index].getBoundingClientRect().width + (index > 0 ? gap : 0);
    if (totalWidth > containerWidth) break;
    visibleCount++;
  }

  if (visibleCount >= chips.length) return;

  moreButton.style.visibility = 'hidden';
  moreButton.style.display = 'inline-flex';
  const moreWidth = moreButton.getBoundingClientRect().width + gap;
  moreButton.style.visibility = '';
  totalWidth = 0;
  visibleCount = 0;
  for (let index = 0; index < chips.length; index++) {
    totalWidth += chips[index].getBoundingClientRect().width + (index > 0 ? gap : 0);
    if (totalWidth > containerWidth - moreWidth) break;
    visibleCount++;
  }
  if (visibleCount >= chips.length) visibleCount = chips.length - 1;
  chips.forEach((chip, index) => {
    chip.style.display = index < Math.max(visibleCount, 0) ? 'inline-flex' : 'none';
  });
  moreButton.style.display = 'inline-flex';
}

/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];

function renderFreeMemoryButton(tabs, action, label, attrs = '') {
  const count = getFreeMemoryCandidates(tabs).length;
  if (count === 0) return '';

  const noun = count === 1 ? 'tab' : 'tabs';
  return `
    <button class="action-btn free-memory" data-action="${action}" ${attrs}>
      ${ICONS.sleep}
      ${label(count, noun)}
    </button>`;
}


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   CHIP BUILDER — shared helper for all tab chip rows
   ---------------------------------------------------------------- */

// Pin icon SVG (small, inline)
const ICON_PIN = `<svg class="chip-protected-icon chip-pin-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-label="Pinned tab"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>`;

// Standalone window icon SVG (small, inline)
const ICON_WINDOW = `<svg class="chip-protected-icon chip-window-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="Standalone window"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><line x1="1.5" y1="6" x2="14.5" y2="6"/><circle cx="4" cy="4.5" r="0.6" fill="currentColor" stroke="none"/><circle cx="6.2" cy="4.5" r="0.6" fill="currentColor" stroke="none"/></svg>`;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMemory(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
}

function renderSystemMemoryStat(label, value, detail = '') {
  return `
    <div class="system-memory-stat">
      <div class="system-memory-label">${escapeHtml(label)}</div>
      <div class="system-memory-value">${escapeHtml(value)}</div>
      ${detail ? `<div class="system-memory-detail">${escapeHtml(detail)}</div>` : ''}
    </div>`;
}

function renderSystemMemoryUnavailable(message) {
  const statsEl = document.getElementById('systemMemoryStats');
  const usageEl = document.getElementById('systemMemoryUsage');
  if (usageEl) usageEl.textContent = '';
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="system-memory-status">
        ${escapeHtml(message)}
      </div>`;
  }
}

async function renderSystemMemoryPanel({ silent = false, enabled } = {}) {
  const panel = document.getElementById('systemMemoryPanel');
  const statsEl = document.getElementById('systemMemoryStats');
  const usageEl = document.getElementById('systemMemoryUsage');
  if (!panel || !statsEl) return;

  const shouldShow = enabled ?? (await getSettings()).showSystemMemory;
  if (!shouldShow) {
    panel.style.display = 'none';
    return;
  }

  if (!silent) {
    statsEl.innerHTML = '<div class="system-memory-loading">Loading memory snapshot...</div>';
    if (usageEl) usageEl.textContent = '';
  }

  if (!hasSystemMemoryApi()) {
    panel.style.display = 'none';
    return;
  }

  const rawInfo = await getSystemMemoryInfo();
  const snapshot = normalizeSystemMemoryInfo(rawInfo);
  if (!snapshot) {
    panel.style.display = 'none';
    return;
  }

  panel.style.removeProperty('display');
  if (usageEl) usageEl.textContent = `${snapshot.usedPercent.toFixed(1)}% used`;
  statsEl.innerHTML = [
    renderSystemMemoryStat('Used', formatMemory(snapshot.usedCapacity)),
    renderSystemMemoryStat('Available', formatMemory(snapshot.availableCapacity)),
    renderSystemMemoryStat('Total', formatMemory(snapshot.capacity)),
  ].join('');
}

function refreshSystemMemoryAfterSleep() {
  setTimeout(() => {
    void renderSystemMemoryPanel({ silent: true });
  }, 500);
}

function getTabStateTone(tab) {
  if (tab.discarded) return 'sleeping';
  if (tab.frozen) return 'frozen';
  return 'live';
}

function getTabStateTitle(tab) {
  if (tab.discarded && tab.freedByTabOut) {
    return 'Freed by Tab Out: this tab is asleep and will reload when selected.';
  }
  if (tab.discarded) {
    return 'Sleeping tab: Chrome has released this tab from memory. It will reload when selected.';
  }
  if (tab.frozen) {
    return 'Frozen tab: Chrome has paused this tab to reduce work.';
  }
  if (tab.active) {
    return 'Live tab: selected in its Chrome window';
  }
  return 'Live background tab: open but not selected in its Chrome window';
}

function renderTabStateBar(tab) {
  const tone = getTabStateTone(tab);
  const title = getTabStateTitle(tab);
  return `<span class="chip-state-bar chip-state-${tone}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`;
}

function renderTabChip(tab, groupDomain, urlCounts = {}) {
  let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), groupDomain || '');
  // For localhost tabs, prepend port number so you can tell projects apart.
  try {
    const parsed = new URL(tab.url);
    if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
  } catch {}

  const count = urlCounts[tab.url] || 1;
  const dupeTag = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
  const isPinned = Boolean(tab.pinned);
  const isAlone = Boolean(tab.isAloneInWindow);
  const classes = [
    'page-chip',
    'clickable',
    count > 1 ? 'chip-has-dupes' : '',
    isPinned ? 'chip-pinned' : '',
    isAlone ? 'chip-alone-window' : '',
    tab.active ? 'is-active-tab' : '',
    tab.discarded && tab.freedByTabOut ? 'is-freed-tab' : '',
    tab.discarded ? 'is-sleeping-tab' : '',
  ].filter(Boolean).join(' ');
  const safeUrl = escapeHtml(tab.url || '');
  const safeTabId = escapeHtml(tab.id ?? '');
  const safeTitle = escapeHtml(label);
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch {}
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
  const badgeOverlay = isPinned ? ICON_PIN : (isAlone ? ICON_WINDOW : '');
  const faviconHtml = faviconUrl
    ? `<span class="chip-favicon-wrap">${badgeOverlay}<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'"></span>`
    : (badgeOverlay ? `<span class="chip-favicon-wrap chip-favicon-wrap--no-img">${badgeOverlay}</span>` : '');

  return `<div class="${classes}" data-action="focus-tab" data-tab-id="${safeTabId}" data-tab-url="${safeUrl}" title="${safeTitle}">
    <span class="chip-state-stack">
      ${faviconHtml}
      ${renderTabStateBar(tab)}
    </span>
    <span class="chip-title-block">
      <span class="chip-text">${safeTitle}${dupeTag}</span>
    </span>
    <div class="chip-actions">
      <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
      </button>
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
  </div>`;
}
function updateTabChipState(chip, tab) {
  if (!chip || !tab) return;

  chip.classList.toggle('is-active-tab', Boolean(tab.active));
  chip.classList.toggle('is-freed-tab', Boolean(tab.discarded && tab.freedByTabOut));
  chip.classList.toggle('is-sleeping-tab', Boolean(tab.discarded));

  const bar = chip.querySelector('.chip-state-bar');
  if (!bar) return;

  const tone = getTabStateTone(tab);
  const title = getTabStateTitle(tab);
  bar.className = `chip-state-bar chip-state-${tone}`;
  bar.title = title;
  bar.setAttribute('aria-label', title);
}

function updateVisibleTabStates() {
  const tabsById = new Map(openTabs.map(tab => [String(tab.id), tab]));
  document.querySelectorAll('.page-chip[data-tab-id]').forEach(chip => {
    const tab = tabsById.get(chip.dataset.tabId);
    if (tab) updateTabChipState(chip, tab);
  });
}

function renderOpenTabsSectionCount() {
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  if (!openTabsSectionCount) return;

  const realTabs = getRealTabs();
  const closableCount = realTabs.filter(tab => !isProtectedTab(tab)).length;
  const protectedCount = realTabs.length - closableCount;
  const closeAllTooltip = protectedCount > 0
    ? `Closes ${closableCount} tab${closableCount !== 1 ? 's' : ''}. Skips ${protectedCount} pinned/window tab${protectedCount !== 1 ? 's' : ''}.`
    : `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}`;
  const closeAllButton = closableCount > 0
    ? `<button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;" title="${closeAllTooltip}">${ICONS.close} Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}</button>`
    : '';
  const globalFreeMemoryButton = renderFreeMemoryButton(
    realTabs,
    'free-memory-all',
    count => `Sleep ${count} inactive tab${count !== 1 ? 's' : ''}`
  );

  openTabsSectionCount.innerHTML = [
    buildViewToggle('domain'),
    `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`,
    closeAllButton,
    globalFreeMemoryButton,
  ].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
}
function getCurrentTabsForGroup(group, { fallbackToSnapshot = false } = {}) {
  const tabsById = new Map(openTabs.map(tab => [tab.id, tab]));
  return (group.tabs || [])
    .map(tab => tabsById.get(tab.id) || (fallbackToSnapshot ? tab : null))
    .filter(Boolean);
}

function updateDomainFreeMemoryButton(group) {
  const stableId = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');
  const card = document.querySelector(`.mission-card[data-domain-id="${stableId}"]`);
  const actions = card && card.querySelector('.actions');
  if (!actions) return;

  const nextHtml = renderFreeMemoryButton(
    getCurrentTabsForGroup(group, { fallbackToSnapshot: true }),
    'free-memory-domain',
    (count, noun) => `Sleep ${count} ${noun}`,
    `data-domain-id="${stableId}"`
  ).trim();
  const existing = actions.querySelector('.action-btn.free-memory[data-action="free-memory-domain"]');

  if (existing && nextHtml) {
    existing.outerHTML = nextHtml;
  } else if (existing) {
    existing.remove();
  } else if (nextHtml) {
    actions.insertAdjacentHTML('afterbegin', nextHtml);
  }
}

function refreshSleepActionUi(changedGroup = null) {
  updateVisibleTabStates();
  renderOpenTabsSectionCount();

  if (changedGroup) {
    updateDomainFreeMemoryButton(changedGroup);
  } else {
    domainGroups.forEach(updateDomainFreeMemoryButton);
  }
}

function getSleepToast(result, label) {
  if (result.slept > 0) {
    return `Put ${result.slept} ${label}${result.slept !== 1 ? 's' : ''} to sleep`;
  }

  return `No ${label}${label.endsWith('tab') ? 's' : ''} to sleep`;
}

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => renderTabChip(tab, '', urlCounts)).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    return renderTabChip(tab, group.domain, urlCounts);
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  const closableCount = tabs.filter(t => !isProtectedTab(t)).length;
  let actionsHtml = renderFreeMemoryButton(
    tabs,
    'free-memory-domain',
    (count, noun) => `Sleep ${count} ${noun}`,
    `data-domain-id="${stableId}"`
  );
  if (closableCount > 0) {
    actionsHtml += `
      <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
        ${ICONS.close}
        Close ${closableCount} tab${closableCount !== 1 ? 's' : ''}
      </button>`;
  }

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const savedSection   = document.getElementById('deferredSavedSection');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column || !savedSection) return;

  try {
    const { active, archived } = await getSavedTabs();

    if (active.length === 0 && archived.length === 0) {
      savedSection.style.display = 'none';
      updateDeferredColumnVisibility();
      return;
    }

    savedSection.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

    updateDeferredColumnVisibility();

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    savedSection.style.display = 'none';
    updateDeferredColumnVisibility();
  }
}

function updateDeferredColumnVisibility() {
  const column = document.getElementById('deferredColumn');
  if (!column) return;
  const hasSaved = document.getElementById('deferredSavedSection')?.style.display !== 'none';
  const hasRecentlyClosed = document.getElementById('recentlyClosedDesktopSection')?.style.display !== 'none';
  column.style.display = hasSaved || hasRecentlyClosed ? 'block' : 'none';
}

function renderRecentlyClosedItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const fallbackFavicon = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=16` : '';
  const faviconUrl = item.favIconUrl || fallbackFavicon;
  const tabCount = Number(item.tabCount) > 1 ? ` · ${Number(item.tabCount)} tabs` : '';
  const title = item.title || item.url || 'Untitled';

  return `
    <button class="recently-closed-item" type="button" data-action="restore-recently-closed" data-session-id="${escapeHtml(item.sessionId)}" aria-label="Restore ${escapeHtml(title)}">
      ${faviconUrl ? `<img class="recently-closed-favicon" src="${escapeHtml(faviconUrl)}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="recently-closed-favicon"></span>'}
      <span class="recently-closed-copy">
        <span class="recently-closed-title">${escapeHtml(title)}</span>
        <span class="recently-closed-meta">${escapeHtml(domain)}${domain ? ' · ' : ''}${escapeHtml(timeAgo(item.closedAt))}${escapeHtml(tabCount)}</span>
      </span>
    </button>`;
}

async function renderRecentlyClosedColumn() {
  const section = document.getElementById('recentlyClosedDesktopSection');
  const list = document.getElementById('recentlyClosedDesktopList');
  const count = document.getElementById('recentlyClosedDesktopCount');
  if (!section || !list || !count) return;

  try {
    const items = TabOutShared?.getRecentlyClosedSnapshot
      ? await TabOutShared.getRecentlyClosedSnapshot()
      : [];
    if (!items.length) {
      section.style.display = 'none';
      list.replaceChildren();
      count.textContent = '';
      updateDeferredColumnVisibility();
      return;
    }

    section.style.display = 'block';
    count.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    list.innerHTML = items.map(renderRecentlyClosedItem).join('');
    updateDeferredColumnVisibility();
  } catch (error) {
    console.warn('[tab-out] Could not load recently closed tabs:', error);
    section.style.display = 'none';
    updateDeferredColumnVisibility();
  }
}

async function renderRightColumn() {
  await Promise.all([renderDeferredColumn(), renderRecentlyClosedColumn()]);
  updateDeferredColumnVisibility();
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/* Chrome Tab Group color → CSS hex mapping */
const CHROME_GROUP_COLORS = {
  grey:   '#5f6368',
  blue:   '#1a73e8',
  red:    '#d93025',
  yellow: '#f9ab00',
  green:  '#1e8e3e',
  pink:   '#e91e63',
  purple: '#9c27b0',
  cyan:   '#00bcd4',
};

/**
 * buildViewToggle(activeView)
 *
 * Returns the HTML for the Groups/Domains toggle pill.
 * Only shown when Chrome tab groups exist (tabGroupsList.length > 0).
 * activeView: 'group' | 'domain'
 */
function buildViewToggle(activeView) {
  if (tabGroupsList.length === 0) return '';
  return `<span class="view-toggle">` +
    `<button class="toggle-pill${activeView === 'group' ? ' active' : ''}" data-action="switch-view" data-view="group">Groups</button>` +
    `<button class="toggle-pill${activeView === 'domain' ? ' active' : ''}" data-action="switch-view" data-view="domain">Domains</button>` +
    `</span>&nbsp;&nbsp;`;
}

/**
 * renderDomainView(realTabs)
 *
 * Groups realTabs by domain and renders domain cards.
 * Extracted from renderStaticDashboard() so the domain view can be
 * called as a standalone branch alongside the group view.
 */
async function renderDomainView(realTabs) {
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true;
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }
      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;
      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch { /* skip malformed URLs */ }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;
    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
    return b.tabs.length - a.tabs.length;
  });

  // Render
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    renderOpenTabsSectionCount();
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }
}

/**
 * renderGroupView()
 *
 * Renders the Chrome tab group view:
 * 1. Chrome groups as cards (with color accent bars)
 * 2. Ungrouped tabs as a lightweight "Not grouped" chip cluster
 */
async function renderGroupView() {
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');
  if (!openTabsSection) return;

  const realTabs = getRealTabs();

  // Partition tabs: grouped (groupId >= 0) vs ungrouped (groupId === -1)
  const groupedTabs   = realTabs.filter(t => t.groupId >= 0);
  const ungroupedTabs = realTabs.filter(t => t.groupId === -1);

  // Build group data: map<groupId, { groupInfo, tabs[] }>
  const groupData = new Map();
  for (const group of tabGroupsList) {
    groupData.set(group.id, { groupInfo: group, tabs: [] });
  }
  for (const tab of groupedTabs) {
    if (groupData.has(tab.groupId)) {
      groupData.get(tab.groupId).tabs.push(tab);
    }
  }

  // Sort groups by minimum tab.index (Chrome's visual order)
  const sortedGroups = Array.from(groupData.values())
    .filter(g => g.tabs.length > 0)
    .sort((a, b) => {
      const aMin = Math.min(...a.tabs.map(t => t.index));
      const bMin = Math.min(...b.tabs.map(t => t.index));
      return aMin - bMin;
    });

  const groupCount = sortedGroups.length;
  const ungroupedCount = ungroupedTabs.length;

  // Render section header with toggle + count
  if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
  const closableCount  = realTabs.filter(t => !isProtectedTab(t)).length;
  const protectedCount = realTabs.length - closableCount;
  const closeAllTooltip = protectedCount > 0
    ? `Closes ${closableCount} tab${closableCount !== 1 ? 's' : ''}. Skips ${protectedCount} pinned/window tab${protectedCount !== 1 ? 's' : ''} — safe to use!`
    : `Close all ${closableCount} tabs`;
  openTabsSectionCount.innerHTML = `${buildViewToggle('group')}${groupCount} group${groupCount !== 1 ? 's' : ''}${ungroupedCount > 0 ? ` · ${ungroupedCount} ungrouped` : ''}${closableCount > 0 ? ` &nbsp;&nbsp;<button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;" title="${closeAllTooltip}">${ICONS.close} Close all ${closableCount} tabs</button>` : ''}`;

  // Render group cards + ungrouped section
  let html = '';

  for (const { groupInfo, tabs } of sortedGroups) {
    html += renderTabGroupCard(groupInfo, tabs);
  }

  if (ungroupedTabs.length > 0) {
    html += renderUngroupedSection(ungroupedTabs);
  }

  if (sortedGroups.length > 0 || ungroupedTabs.length > 0) {
    openTabsMissionsEl.innerHTML = html;
    openTabsSection.style.display = 'block';
  } else {
    openTabsMissionsEl.innerHTML = '';
    openTabsSection.style.display = 'none';
  }
}

/**
 * renderTabGroupCard(groupInfo, tabs)
 *
 * Renders a Chrome tab group as a card, similar to renderDomainCard().
 * Uses the group color for the status bar. Same chip structure as domain cards.
 */
function renderTabGroupCard(groupInfo, tabs) {
  const color  = CHROME_GROUP_COLORS[groupInfo.color] || '#5f6368';
  const name   = groupInfo.title || '(unnamed)';
  const tabCount = tabs.length;

  const { urlCounts, uniqueTabs, hasDupes, totalExtras, dupeUrls } = detectDuplicateTabs(tabs);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  const visibleTabs  = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => renderTabChip(tab, '', urlCounts)).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  const closableCount = tabs.filter(t => !isProtectedTab(t)).length;
  let actionsHtml = (closableCount > 0 ? `
    <button class="action-btn close-tabs" data-action="close-group-tabs" data-group-id="${groupInfo.id}">
      ${ICONS.close}
      Close ${closableCount} tab${closableCount !== 1 ? 's' : ''}
    </button>` : '') + `
    <button class="action-btn" data-action="ungroup-tabs" data-group-id="${groupInfo.id}" style="color:var(--accent-blue);">
      Ungroup
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  const stableId = 'group-' + String(groupInfo.id);

  return `
    <div class="mission-card group-card" data-group-id="${stableId}">
      <div class="status-bar" style="background:${color}"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${name}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}

/**
 * renderUngroupedSection(ungroupedTabs)
 *
 * Lightweight chip cluster for ungrouped tabs in group view.
 * NOT a full domain card — just a labeled chip section.
 */
function renderUngroupedSection(ungroupedTabs) {
  const { urlCounts, uniqueTabs, hasDupes, totalExtras, dupeUrls } = detectDuplicateTabs(ungroupedTabs);

  const chips = uniqueTabs.map(tab => renderTabChip(tab, '', urlCounts)).join('');

  let dedupBtn = '';
  if (hasDupes) {
    const enc = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    dedupBtn = `<button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${enc}">Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}</button>`;
  }

  return `
    <div class="ungrouped-section${hasDupes ? ' has-dupes' : ''}">
      <div class="ungrouped-header">
        <div class="ungrouped-label">Not grouped</div>
        ${dedupBtn}
      </div>
      <div class="ungrouped-chips">${chips}</div>
    </div>`;
}

async function refreshOpenTabsDashboard() {
  await Promise.all([fetchOpenTabs(), fetchTabGroups()]);
  const storedView = await loadViewMode();
  const view = tabGroupsList.length === 0 ? 'domain' : storedView;
  if (view === 'group') {
    await renderGroupView();
  } else {
    await renderDomainView(getRealTabs());
  }
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;
}

function configureDashboardRefresh(intervalSeconds) {
  if (window._tabOutRefreshTimer) clearInterval(window._tabOutRefreshTimer);
  window._tabOutRefreshTimer = null;
  if (![10, 30, 60].includes(Number(intervalSeconds))) return;
  window._tabOutRefreshTimer = setInterval(refreshOpenTabsDashboard, Number(intervalSeconds) * 1000);
}

async function renderStaticDashboard() {
  const settings = await getSettings();
  const rightColumnRender = renderRightColumn();
  const memoryRender = renderSystemMemoryPanel({ enabled: settings.showSystemMemory });

  await refreshOpenTabsDashboard();
  await memoryRender;
  checkTabOutDupes();
  await rightColumnRender;
  configureDashboardRefresh(settings.refreshIntervalSeconds);
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'restore-recently-closed') {
    const sessionId = actionEl.dataset.sessionId;
    if (!sessionId || !chrome.sessions?.restore) return;
    try {
      await chrome.sessions.restore(sessionId);
      await renderRecentlyClosedColumn();
      showToast('Tab restored');
    } catch (error) {
      console.warn('[tab-out] Could not restore recently closed tab:', error);
      showToast('Failed to restore tab');
    }
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  // ---- Refresh system memory snapshot ----
  if (action === 'refresh-system-memory') {
    await renderSystemMemoryPanel();
    return;
  }

  const card = actionEl.closest('.mission-card');
  const ungroupedSection = actionEl.closest('.ungrouped-section');

  // ---- Free memory from all eligible inactive tabs ----
  if (action === 'free-memory-all') {
    await fetchOpenTabs();
    const result = sleepTabsOptimistically(getRealTabs());
    refreshSleepActionUi();
    refreshSystemMemoryAfterSleep();
    showToast(getSleepToast(result, 'inactive tab'));
    return;
  }

  // ---- Free memory from eligible inactive tabs in one domain group ----
  if (action === 'free-memory-domain') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    await fetchOpenTabs();
    const result = sleepTabsOptimistically(getCurrentTabsForGroup(group));
    refreshSleepActionUi(group);
    refreshSystemMemoryAfterSleep();
    showToast(getSleepToast(result, `${groupLabel} tab`));
    return;
  }

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly — single close has no restrictions
    const allTabs = await chrome.tabs.query({});
    const match = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out, then remove card if empty
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    if (ungroupedSection) {
      ungroupedSection.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity = '0';
        setTimeout(() => b.remove(), 200);
      });
      ungroupedSection.classList.remove('has-dupes');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Switch view mode (Groups <-> Domains) ----
  if (action === 'switch-view') {
    const newView = actionEl.dataset.view;
    await saveViewMode(newView);
    await renderDashboard();
    return;
  }

  // ---- Close all tabs in a Chrome tab group ----
  if (action === 'close-group-tabs') {
    const groupId = Number(actionEl.dataset.groupId);
    const groupTabs = openTabs.filter(t => t.groupId === groupId);
    const tabIds = groupTabs.map(t => t.id);
    // Shoot confetti before closing so card is still in DOM
    const card = document.querySelector(`[data-group-id="group-${groupId}"]`);
    if (card) {
      const rect = card.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    await closeTabsByIds(tabIds);
    playCloseSound();
    showToast(`Closed ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''} from group`);
    await renderDashboard();
    return;
  }

  // ---- Ungroup a Chrome tab group (move tabs out) ----
  if (action === 'ungroup-tabs') {
    const groupId = Number(actionEl.dataset.groupId);
    const groupTabs = openTabs.filter(t => t.groupId === groupId);
    for (const tab of groupTabs) {
      try { await chrome.tabs.ungroup(tab.id); } catch { /* already closed or ungrouped */ }
    }
    await fetchOpenTabs();
    await renderDashboard();
    showToast(`Ungrouped ${groupTabs.length} tab${groupTabs.length !== 1 ? 's' : ''}`);
    return;
  }

  // ---- Close ALL open tabs (skips pinned + lone-window tabs) ----
  if (action === 'close-all-open-tabs') {
    const closableUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:') && !isProtectedTab(t))
      .map(t => t.url);
    await closeTabsByUrls(closableUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    const protectedCount = openTabs.filter(t => isProtectedTab(t)).length;
    showToast(protectedCount > 0
      ? `Tabs closed. ${protectedCount} pinned/window tab${protectedCount !== 1 ? 's' : ''} kept.`
      : 'All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   KEYBOARD SHORTCUTS
   ---------------------------------------------------------------- */

// Ctrl/Cmd + Shift + G — toggle between group and domain view
document.addEventListener('keydown', async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'G') {
    e.preventDefault();
    const stored = await loadViewMode();
    const current = (tabGroupsList.length === 0) ? 'domain' : stored;
    const next = current === 'group' ? 'domain' : 'group';
    await saveViewMode(next);
    await renderDashboard();
  }
});

/* ----------------------------------------------------------------
   设置面板
   ---------------------------------------------------------------- */
(function initSettings() {
  const modal = document.getElementById('settingsModal');
  const openButton = document.getElementById('settingsBtn');
  const closeButton = document.getElementById('settingsClose');
  const backdrop = document.getElementById('settingsBackdrop');
  const logoInput = document.getElementById('logoUrl');
  const showTabListToggle = document.getElementById('showTabListToggle');
  const tabListTextarea = document.getElementById('tabListItems');
  const refreshInterval = document.getElementById('refreshInterval');
  const showSystemMemoryToggle = document.getElementById('showSystemMemoryToggle');
  const remoteSyncToggle = document.getElementById('remoteSyncToggle');
  const remoteServerUrl = document.getElementById('remoteServerUrl');
  const extensionKey = document.getElementById('extensionKey');
  const remoteStatus = document.getElementById('remoteStatus');
  if (!modal || !openButton) return;

  function applyLogo(url) {
    const logo = document.getElementById('customLogo');
    if (!logo) return;
    if (url) {
      logo.src = url;
      logo.style.display = 'block';
      logo.onerror = () => { logo.style.display = 'none'; };
    } else {
      logo.style.display = 'none';
      logo.removeAttribute('src');
    }
  }

  function renderRemoteStatus(status, enabled) {
    if (!remoteStatus) return;
    const effective = enabled ? (status || { state: 'connecting' }) : { state: 'disabled' };
    const labels = {
      disabled: 'Remote sync is off',
      connecting: 'Connecting…',
      connected: 'Connected',
      error: 'Connection failed',
    };
    remoteStatus.dataset.state = effective.state || 'disabled';
    remoteStatus.textContent = effective.message || labels[effective.state] || labels.disabled;
  }

  async function loadRemoteStatus() {
    try {
      const stored = await chrome.storage.local.get('remoteConnectionStatus');
      return stored.remoteConnectionStatus || null;
    } catch {
      return null;
    }
  }

  async function loadSettingsIntoUi() {
    const [settings, status] = await Promise.all([getSettings(), loadRemoteStatus()]);
    if (logoInput) logoInput.value = settings.logoUrl || '';
    if (showTabListToggle) showTabListToggle.checked = settings.showTabList !== false;
    if (tabListTextarea) tabListTextarea.value = tabListItemsToText(settings.tabListItems);
    if (refreshInterval) refreshInterval.value = String(settings.refreshIntervalSeconds);
    if (showSystemMemoryToggle) showSystemMemoryToggle.checked = settings.showSystemMemory === true;
    if (remoteSyncToggle) remoteSyncToggle.checked = settings.remoteSyncEnabled === true;
    if (remoteServerUrl) remoteServerUrl.value = settings.remoteServerUrl || DEFAULT_SETTINGS.remoteServerUrl;
    if (extensionKey) extensionKey.value = settings.extensionKey || '';
    renderRemoteStatus(status, settings.remoteSyncEnabled);
    return settings;
  }

  async function commitSettings() {
    const next = {
      logoUrl: logoInput ? logoInput.value.trim() : '',
      showTabList: showTabListToggle ? showTabListToggle.checked : true,
      tabListItems: parseTabListItems(tabListTextarea ? tabListTextarea.value : ''),
      refreshIntervalSeconds: refreshInterval ? Number(refreshInterval.value) : 30,
      showSystemMemory: showSystemMemoryToggle ? showSystemMemoryToggle.checked : false,
      remoteSyncEnabled: remoteSyncToggle ? remoteSyncToggle.checked : false,
      remoteServerUrl: remoteServerUrl ? remoteServerUrl.value.trim() : DEFAULT_SETTINGS.remoteServerUrl,
      extensionKey: extensionKey ? extensionKey.value.trim() : '',
    };
    const saved = await saveSettings(next);
    if (!saved) return;
    applyLogo(saved.logoUrl);
    await renderTabList();
    await renderSystemMemoryPanel({ enabled: saved.showSystemMemory });
    configureDashboardRefresh(saved.refreshIntervalSeconds);
    renderRemoteStatus({ state: saved.remoteSyncEnabled ? 'connecting' : 'disabled' }, saved.remoteSyncEnabled);
  }

  function closeModal() {
    modal.style.display = 'none';
  }

  openButton.addEventListener('click', async () => {
    await loadSettingsIntoUi();
    modal.style.display = 'flex';
  });
  if (closeButton) closeButton.addEventListener('click', closeModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.style.display !== 'none') closeModal();
  });

  if (logoInput) logoInput.addEventListener('change', commitSettings);
  if (showTabListToggle) showTabListToggle.addEventListener('change', commitSettings);
  if (refreshInterval) refreshInterval.addEventListener('change', commitSettings);
  if (showSystemMemoryToggle) showSystemMemoryToggle.addEventListener('change', commitSettings);
  if (remoteSyncToggle) remoteSyncToggle.addEventListener('change', commitSettings);
  if (tabListTextarea) {
    let inputTimer = null;
    tabListTextarea.addEventListener('input', () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(commitSettings, 600);
    });
  }
  for (const input of [remoteServerUrl, extensionKey]) {
    if (!input) continue;
    let inputTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(commitSettings, 500);
    });
  }

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.remoteConnectionStatus) return;
      getSettings().then(settings => {
        renderRemoteStatus(changes.remoteConnectionStatus.newValue, settings.remoteSyncEnabled);
      });
    });
  }

  setTimeout(() => {
    loadSettingsIntoUi().then(settings => {
      applyLogo(settings.logoUrl);
      return renderTabList();
    });
  }, 0);
})();

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
