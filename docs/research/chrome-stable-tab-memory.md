# 稳定版 Chrome 中查看高内存 tab 的可行入口

Research date: 2026-07-04

## 简短结论

在非 Dev/Canary 的稳定版 Chrome 里，用户手动判断“当前哪些 tab 内存占用高”的首选入口是 Chrome Task Manager：官方 DevTools 文档明确说它是实时监控起点，可以看到页面使用的内存，并解释 `Memory footprint` 代表 OS memory、`JavaScript Memory` 代表 JS heap。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#monitor-memory-use-in-realtime-with-the-chrome-task-manager)

DevTools 的 Performance、Performance monitor、Memory panel 适合对某一个已选页面做进一步诊断，不是跨所有 tab 的排行榜：Performance panel 可以记录页面内存随时间变化，Performance monitor 实时显示当前站点的 CPU、JS heap、DOM nodes 等指标，Memory panel 的 heap snapshot 展示某个时间点页面 JS objects 和 DOM nodes 的内存分布。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#visualize-memory-leaks-with-performance-recordings) [Chrome DevTools: Performance monitor panel](https://developer.chrome.com/docs/devtools/performance-monitor) [Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#discover-detached-dom-tree-memory-leaks-with-heap-snapshots)

对 Tab Out 这样的 Chrome extension，稳定版 extension API 不能可靠获取“每个 tab 的精确内存 MB”。最接近的 `chrome.processes` API 明确标注 `Availability: Dev channel`，并且它返回的是 process 级 `privateMemory`，tab 只是 `tasks[]` 里的可选 `tabId` 关联；这既不能在稳定版发布路径依赖，也不是严格的 per-tab 分摊值。[chrome.processes API](https://developer.chrome.com/docs/extensions/reference/api/processes)

稳定版可用的产品信号应来自 `chrome.tabs` 的状态字段，例如 `active`、`discarded`、`frozen`、`autoDiscardable`、`lastAccessed`、`audible`、`pinned`，以及整机级 `chrome.system.memory.getInfo()`；这些只能表达 tab 状态、最近活跃度或整机内存压力，不能表达某个 tab 的精确内存占用。[chrome.tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab) [chrome.system.memory API](https://developer.chrome.com/docs/extensions/reference/api/system/memory)

## 用户手动查看入口

### 1. Chrome Task Manager

操作步骤：

1. 在 Chrome 里按 `Shift+Esc`，或者从 Chrome 主菜单进入 `More tools > Task manager`。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#monitor-memory-use-in-realtime-with-the-chrome-task-manager) Chrome Help 的快捷键表也把 `Shift + Esc` 列为打开 Chrome Task Manager 的快捷键。[Chrome keyboard shortcuts](https://support.google.com/chrome/answer/157179)
2. 查看并按 `Memory footprint` 列排序，用它找当前 OS memory 占用较高的页面；官方说明 `Memory footprint` 代表 OS memory。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#monitor-memory-use-in-realtime-with-the-chrome-task-manager)
3. 如需区分 JS heap，右键 Task Manager 表头并启用 `JavaScript memory`；官方说明该列展示 JS heap，其中括号内 live number 代表页面 reachable objects 正在使用的内存。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#monitor-memory-use-in-realtime-with-the-chrome-task-manager)

可用性判断：这些说明来自 Chrome DevTools 官方文档和 Google Chrome Help 的普通 Chrome 功能说明，没有 Dev/Canary channel 限制；它们是稳定版 Chrome 用户可以使用的手动入口。[Chrome DevTools overview](https://developer.chrome.com/docs/devtools/overview) [Chrome keyboard shortcuts](https://support.google.com/chrome/answer/157179)

### 2. Tab hover memory usage 和 Performance settings

Chrome Help 说明可以在 `Settings > Appearance` 中打开或关闭 tab hover preview card 上的 memory usage 显示；Windows/Linux/Chromebook 路径是 `Tab hover preview card > Show tab memory usage`，Mac 路径是 `Show memory usage on tab hover preview card`。[Personalize Chrome performance](https://support.google.com/chrome/answer/12929150)

这个入口适合用户逐个 hover tab 看当前提示值，但官方文档没有把它描述为可排序的全局 tab 内存列表；所以它可以作为快速查看单个 tab 的辅助入口，不能替代 Task Manager 的跨 tab 排序。[Personalize Chrome performance](https://support.google.com/chrome/answer/12929150)

Chrome Help 还说明 `Performance issue alerts` 会在浏览性能较差时发送建议 tab deactivation 的通知，并允许用户点击 `Fix now`；这属于 Chrome 主动提示，不是用户随时可查询的精确 per-tab 内存 API。[Personalize Chrome performance](https://support.google.com/chrome/answer/12929150)

### 3. DevTools Performance / Performance monitor / Memory panel

Chrome DevTools 是内置在 Google Chrome 里的开发者工具。[Chrome DevTools overview](https://developer.chrome.com/docs/devtools/overview)

适用方式：

1. 已经从 Task Manager 或 hover card 判断某个页面可疑后，打开该页面的 DevTools。
2. 在 Performance panel 勾选 `Memory` 并录制，观察 JS heap、documents、DOM nodes、listeners、GPU memory 等随时间变化；官方文档把它定位为页面内存随时间变化的可视化诊断。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#visualize-memory-leaks-with-performance-recordings)
3. 打开 Performance monitor，可实时看当前站点的 CPU usage、JavaScript heap size、DOM nodes、event listeners、documents、frames、layouts 和 style recalculations 等指标。[Chrome DevTools: Performance monitor panel](https://developer.chrome.com/docs/devtools/performance-monitor)
4. 打开 Memory panel 可做 heap snapshot 或 allocation profiling，官方说明 heap snapshot 展示某个时间点页面 JS objects 和 DOM nodes 的内存分布，allocation sampling 会按 JavaScript function 展示内存分配。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#discover-detached-dom-tree-memory-leaks-with-heap-snapshots) [Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#investigate-memory-allocation-by-function)

边界：这些 DevTools 工具用于“当前 inspected page / site”的诊断；它们适合找内存泄漏、DOM 节点增长、JS heap 增长原因，不适合直接替代 Task Manager 去列出所有打开 tab 的总内存排名。[Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems)

## 非 Dev/Canary Chrome 是否能用

能用的用户入口：

- Chrome Task Manager：Chrome Help 明确列出 `Shift+Esc` 打开 Chrome Task Manager，DevTools 官方文档也给出主菜单 `More tools > Task manager` 路径。[Chrome keyboard shortcuts](https://support.google.com/chrome/answer/157179) [Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems#monitor-memory-use-in-realtime-with-the-chrome-task-manager)
- Chrome Performance settings、Memory Saver、tab hover memory usage：Chrome Help 面向普通 desktop Chrome 用户说明这些设置路径，并只排除了 iOS/Android 的 performance personalization。[Personalize Chrome performance](https://support.google.com/chrome/answer/12929150)
- Chrome DevTools：官方说明 DevTools built directly into Google Chrome，并提供普通打开方式。[Chrome DevTools overview](https://developer.chrome.com/docs/devtools/overview)

不能作为稳定版 extension 依赖的入口：

- `chrome.processes`：官方 extension API 页面把该 API 标为 `Availability: Dev channel`；即使它有 `getProcessIdForTab()`、`getProcessInfo(includeMemory)`、`privateMemory`、`jsMemoryUsed` 等能力，也不属于稳定版 extension 发布路径。[chrome.processes API](https://developer.chrome.com/docs/extensions/reference/api/processes)

## 对 Tab Out 的产品/API 影响

### 不应承诺精确 per-tab memory

Tab Out 不应在稳定版里展示“每个 tab 当前精确占用 N MB”的产品承诺。官方 extension API 中真正接近 process memory 的 `chrome.processes` 只在 Dev channel 可用；它的 `privateMemory` 是 process 级字段，而 `tasks[]` 只是 process 下任务列表，`TaskInfo.tabId` 还是可选字段。[chrome.processes API](https://developer.chrome.com/docs/extensions/reference/api/processes)

`chrome.system.memory.getInfo()` 只能获取 physical memory 的 `capacity` 和 `availableCapacity`，是整机级内存信息，不包含 tabId 或 processId，因此可用于整体内存压力提示，不能用于 per-tab 排名。[chrome.system.memory API](https://developer.chrome.com/docs/extensions/reference/api/system/memory)

`chrome.debugger` 是稳定版可用的调试传输 API，可以 attach 到 tab 并发送 Chrome DevTools Protocol commands，但它需要 `"debugger"` 权限，官方也说明出于安全原因只开放部分 CDP domains；其允许列表包含 `Performance`，但不包含 CDP `Memory` 或 `SystemInfo` domain。[chrome.debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) CDP `Performance.getMetrics` 官方只承诺返回 current run-time metrics 的 name/value 列表，不是 Task Manager 的 OS/private memory per tab 值。[CDP Performance domain](https://chromedevtools.github.io/devtools-protocol/1-3/Performance/)

### 可以做的稳定版近似信号

Tab Out 可以用这些 stable `chrome.tabs` 字段构造“内存友好/可清理”状态，而不是内存 MB：

- `discarded`：表示 tab content 已从内存卸载，但 tab 仍显示在 tab strip，激活时重新加载；该字段和 `tabs.discard()` 从 Chrome 54+ 可用。[chrome.tabs Tab.discarded](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab) [chrome.tabs.discard](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-discard)
- `frozen`：Chrome 132+，表示 tab 不能执行 tasks、event handlers 或 timers，但内容仍 loaded in memory，激活时解冻。[chrome.tabs Tab.frozen](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)
- `active`：表示 tab 是否是其 window 里的 active tab；这不等于 window focused。[chrome.tabs Tab.active](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)
- `lastAccessed`：Chrome 121+，记录 tab 最近成为其 window active tab 的 epoch milliseconds，可用于“很久没访问”的排序。[chrome.tabs Tab.lastAccessed](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)
- `autoDiscardable`：Chrome 54+，表示资源不足时 browser 是否可以自动 discard 该 tab。[chrome.tabs Tab.autoDiscardable](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)
- `audible` 和 `pinned`：可用来解释为什么某些 tab 不适合作为清理候选；Chrome Help 也列出 active audio/video、pinned tabs 等活动或设置可能阻止 tab deactivation。[chrome.tabs Tab.audible](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab) [chrome.tabs Tab.pinned](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab) [Personalize Chrome performance](https://support.google.com/chrome/answer/12929150)

产品建议：

- UI 文案用“Inactive / discarded / frozen / old tab / likely safe to clean up”这类状态表达，不用“high memory tab”或“uses X MB”，除非只是引导用户去 Chrome Task Manager 手动确认。[chrome.tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- 如果要释放资源，可以对非 active、可丢弃 tab 提供 `discard` 操作；官方说明 `chrome.tabs.discard()` 会从内存 discard tab，discarded tab 仍在 tab strip 中，激活时重新加载，且 active 或已 discarded 的 tab 不会被 discard。[chrome.tabs.discard](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-discard)
- 可以保留整机级 memory pressure 指标，例如 “Chrome reports low available system memory”，但数据来源应标明是 device-wide physical memory，而不是 tab-level memory。[chrome.system.memory API](https://developer.chrome.com/docs/extensions/reference/api/system/memory)

## Sources

- [Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems)
- [Chrome DevTools: Performance monitor panel](https://developer.chrome.com/docs/devtools/performance-monitor)
- [Chrome DevTools overview](https://developer.chrome.com/docs/devtools/overview)
- [Google Chrome Help: Chrome keyboard shortcuts](https://support.google.com/chrome/answer/157179)
- [Google Chrome Help: Personalize Chrome performance](https://support.google.com/chrome/answer/12929150)
- [Chrome Extensions API: chrome.processes](https://developer.chrome.com/docs/extensions/reference/api/processes)
- [Chrome Extensions API: chrome.tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome Extensions API: chrome.system.memory](https://developer.chrome.com/docs/extensions/reference/api/system/memory)
- [Chrome Extensions API: chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol stable 1.3: Performance domain](https://chromedevtools.github.io/devtools-protocol/1-3/Performance/)
