/**
 * background.js — Service Worker
 *
 * Chrome's "always-on" background script for Tab Out. Two jobs:
 *
 * 1. Keep the toolbar badge showing the current open tab count.
 *    Since we no longer have a server, we query chrome.tabs directly.
 *    The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 *    Color coding gives a quick at-a-glance health signal:
 *      Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *      Amber  (#b8892e) → 11–20 tabs (getting busy)
 *      Red    (#b35a5a) → 21+ tabs   (time to cull!)
 *
 * 2. Open the dashboard when the toolbar icon is clicked (or Ctrl+Shift+K is
 *    pressed). The action has no default_popup, so without an onClicked
 *    listener clicking the icon would do nothing at all.
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Toolbar click → open the dashboard ──────────────────────────────────────

/**
 * openDashboard()
 *
 * Focuses an already-open Tab Out dashboard if there is one, otherwise opens
 * a new tab with it.
 *
 * We navigate to the extension's own index.html by absolute URL rather than
 * just opening a blank new tab. Opening a new tab would rely on the
 * chrome_url_overrides.newtab override actually being honoured, which is not
 * guaranteed on every Chromium browser (Vivaldi, for instance, keeps its own
 * Speed Dial as the new tab page unless the user opts in). The absolute URL
 * works everywhere.
 */
async function openDashboard() {
  const dashboardUrl = chrome.runtime.getURL('index.html');

  try {
    // Reuse an existing dashboard tab instead of piling up duplicates
    const existing = await chrome.tabs.query({ url: dashboardUrl });

    if (existing.length > 0) {
      const tab = existing[0];
      await chrome.tabs.update(tab.id, { active: true });
      // Bring its window forward too — the tab may live in another window
      try { await chrome.windows.update(tab.windowId, { focused: true }); }
      catch { /* window may have been closed mid-flight */ }
      return;
    }

    await chrome.tabs.create({ url: dashboardUrl });
  } catch {
    // Last resort: a plain new tab. If the newtab override is active the user
    // still lands on the dashboard.
    try { await chrome.tabs.create({}); } catch { /* nothing more we can do */ }
  }
}

// Toolbar icon click (also fires for the Ctrl+Shift+K command, since
// _execute_action falls through to onClicked when there is no popup)
chrome.action.onClicked.addListener(() => {
  openDashboard();
});

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
