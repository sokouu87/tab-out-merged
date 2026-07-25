# Tab Out

Tab Out is a Chrome extension that helps users inspect, group, and clean up their open browser tabs from the new tab page.

## Language

**Live Tab**:
A tab whose page is still loaded and may still execute work. This includes both active and background tabs.
_Avoid_: using active/background as separate resource states

**Active Tab**:
A live tab that is currently selected in its Chrome window. This is a focus state, not a separate resource state.
_Avoid_: active page, unactive tab

**Background Tab**:
A live tab that is open but not currently selected in its Chrome window. It may still run JavaScript, play audio, receive network updates, and hold page state.
_Avoid_: unactive tab, inactive tab

**Sleeping Tab**:
A tab whose page contents have been released from memory by Chrome and will reload when selected again.
_Avoid_: unactive tab, inactive tab, closed tab

**Freed Feedback**:
A short-lived UI feedback state for a sleeping tab that Tab Out just put to sleep with `chrome.tabs.discard()`. It is not a separate Chrome resource state and should collapse back to Sleeping after the brief feedback window or when the tab becomes live again.
_Avoid_: freed tab as a long-term state, freed memory amount, exact memory saved

**Frozen Tab**:
A tab whose page contents remain in memory, but Chrome has paused task execution to reduce background work.
_Avoid_: sleeping tab, discarded tab, closed tab

**Sleep Tabs / Free Memory**:
The cleanup action that calls `chrome.tabs.discard()` on eligible tabs. Prefer user-facing action copy such as "Sleep N inactive tabs" over "Close all" or exact memory promises.
_Avoid_: close all, kill tabs, free X MB

**System Memory Snapshot**:
A point-in-time reading of device-wide physical memory from `chrome.system.memory.getInfo()`, including total and available capacity. It is not Chrome's own memory usage.
_Avoid_: Chrome memory, browser memory, tab memory

## Product Decisions

- Tab Out is a cleanup tool, not a per-tab memory profiler. Stable Chrome extension APIs do not provide reliable per-tab memory MB values.
- Exact per-tab memory investigation should be directed to Chrome Task Manager (`Shift+Esc`, sort by Memory footprint), not represented as extension data.
- The primary cleanup action is sleeping tabs with `chrome.tabs.discard()`, not bulk closing tabs.
- Bulk "Close all" actions should not be the main cleanup path.
- Eligible sleep candidates exclude active, already discarded, non-auto-discardable, audible, and pinned tabs.
- Sleep actions should use optimistic UI updates: immediately mark eligible tabs as Sleeping/Freed Feedback in Tab Out, then call `chrome.tabs.discard()` in the background. Do not add failure rollback unless the product explicitly needs it.
- Keep optimistic Sleeping state separate from Freed Feedback. Optimistic Sleeping prevents later tab fetches from reverting the current Tab Out page to Live; Freed Feedback is only the short-lived row accent.
- After a Sleep action, refresh the System Memory Snapshot silently so the numbers update without showing the loading state or re-rendering unrelated dashboard sections.

## Tab State Color Model

Resource states should be rendered as:

- **Live**: active and background tabs share one resource state color.
- **Frozen**: paused by Chrome but still loaded in memory.
- **Sleeping**: discarded by Chrome and will reload when selected.
- **Freed Feedback**: same sleeping resource state, plus a short-lived accent/highlight showing Tab Out just performed the action.

Freed Feedback should not use a separate status-bar color from Sleeping. Use the Sleeping status bar plus a temporary row-level accent.
