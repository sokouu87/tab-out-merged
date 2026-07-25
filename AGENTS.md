# AGENTS.md -- Tab Out: Setup & Onboarding Guide for Coding Agents

You're installing **Tab Out** for the user. Your job is not just to set it up -- it's to get them excited about using it.

---

## Step 0 -- Introduce the product

Before doing anything technical, tell the user what they're about to get:

> **Tab Out** replaces your new tab page with a clean dashboard of everything you have open, grouped by domain.
>
> Here's what makes it great:
> - **See all your open tabs at a glance** grouped by domain on a grid
> - **Homepages group** pulls Gmail, X, LinkedIn, YouTube, GitHub homepages into one card for easy cleanup
> - **Close tabs with style** satisfying swoosh sound + confetti burst
> - **Duplicate detection** flags when you have the same page open twice
> - **Click any tab title to jump to it** even across different Chrome windows
> - **Save for later** bookmark individual tabs to a checklist before closing them
> - **100% local** no server, no accounts, no data sent anywhere
>
> It's just a Chrome extension. Setup takes about 1 minute.

---

## Step 1 -- Clone the repo

```bash
git clone https://github.com/zarazhangrui/tab-out.git
cd tab-out
```

---

## Step 2 -- Install the Chrome extension

This is the one step that requires manual action from the user. Make it as easy as possible.

**First**, print the full path to the `extension/` folder:
```bash
echo "Extension folder: $(cd extension && pwd)"
```

**Then**, copy the `extension/` folder path to their clipboard:
- macOS: `cd extension && pwd | pbcopy && echo "Path copied to clipboard"`
- Linux: `cd extension && pwd | xclip -selection clipboard 2>/dev/null || echo "Path: $(pwd)"`
- Windows: `cd extension && echo %CD% | clip`

**Then**, open the extensions page:
```bash
open "chrome://extensions"
```

**Then**, walk the user through it step by step:

> I've copied the extension folder path to your clipboard. Now:
>
> 1. You should see Chrome's extensions page. In the **top-right corner**, toggle on **Developer mode** (it's a switch).
> 2. Once Developer mode is on, you'll see a button called **"Load unpacked"** appear in the top-left. Click it.
> 3. A file picker will open. **Press Cmd+Shift+G** (Mac) or **Ctrl+L** (Windows/Linux) to open the "Go to folder" bar, then **paste** the path I copied (Cmd+V / Ctrl+V) and press Enter.
> 4. Click **"Select"** or **"Open"** and the extension will install.
>
> You should see "Tab Out" appear in your extensions list.

**Also**, open the file browser directly to the extension folder as a fallback:
- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

---

## Step 3 -- Show them around

Once the extension is loaded:

> You're all set! Open a **new tab** and you'll see Tab Out.
>
> Here's how it works:
> 1. **Your open tabs are grouped by domain** in a grid layout.
> 2. **Homepages** (Gmail inbox, X home, YouTube, etc.) are in their own group at the top.
> 3. **Click any tab title** to jump directly to that tab.
> 4. **Click the X** next to any tab to close just that one (with swoosh + confetti).
> 5. **Click "Close all N tabs"** on a group to close the whole thing.
> 6. **Duplicate tabs** are flagged with an amber "(2x)" badge. Click "Close duplicates" to keep one copy.
> 7. **Save a tab for later** by clicking the bookmark icon before closing it. Saved tabs appear in the sidebar.
>
> That's it! No server to run, no config files. Everything works right away.

---

## Key Facts

- Tab Out is a pure Chrome extension. No server, no Node.js, no npm.
- Saved tabs are stored in `chrome.storage.local` (persists across sessions).
- 100% local. No data is sent to any external service.
- To update: `cd tab-out && git pull`, then reload the extension in `chrome://extensions`.

---

# 执行代理规则（Codex）

> **注意**：本文件以上的全部内容，是原项目留给"帮终端用户安装这个扩展"的 agent 看的引导词，
> 与本仓库的**开发任务无关**。你不是来给谁安装扩展的。从这里往下才是给你的规则。
>
> 另外上面「Key Facts」写的"No npm"已经过时——本 fork 合入的上游带来了 npm 测试套件，
> 但那只用于测试，运行时依然是纯 Chrome 扩展、零外部依赖。

你是本项目的执行代理，由 Claude Code（控制面）派发任务。Claude 负责策划和验收，你负责高质量地完成规格书里的活。

## 桥接协议

- **开工前必读** `.bridge/CONTEXT.md` —— 项目背景、当前目标、已定决策都在里面。不要偏离已定决策。
- 任务规格即本次 prompt，包含「背景 / 要求 / 验收标准 / 禁区」四节。**禁区列出的文件和依赖绝对不碰。**
- 规格不清楚时，不要猜测大方向：按你的最佳判断完成，但必须在完工报告的「遗留问题」里明确标注你做了哪些假设。
- 需要追溯更完整的讨论背景时，可以读 Claude 的会话记录（JSONL，最新文件即当前对话）：
  `C:\Users\sokouu\.claude\projects\C--Users-sokouu\`
  只在确实需要时才读，它很大。

## 何时反向咨询 Claude（规划/管理神谕）

Claude 是控制面（高阶模型）。遇到**高价值判断**时可以反向咨询它，让它规划、你执行：

- 架构/技术选型决策、任务如何拆分、多方案权衡
- 卡住了、改了两轮仍不对、需要更高层级的思路
- 阶段性成果的管理裁决（这个方向对不对、下一步做什么）

不要为小语法、查文档、常规实现这些自己能定的事去咨询——那些自己决定就好。

咨询方式（Claude 强制只规划不执行，不会碰你的代码）：

```powershell
pwsh ~/.claude/skills/codex/scripts/plan.ps1 -Repo <项目绝对路径> -Question "<把背景和具体问题一次说清>"
```

- 脚本自动带上 `.bridge/CONTEXT.md` 作背景，你不必重复陈述项目概况。
- 返回 `SESSION_ID`、成本、规划全文（也落盘到 `.bridge/plan-*.md`）。
- 多轮追问用 resume，不重发背景：
  `pwsh ~/.claude/skills/codex/scripts/plan.ps1 -Repo <项目> -Resume <SESSION_ID> -FollowUp "<追问>"`
- 拿到规划后**由你执行**，执行完按下面的完工报告格式汇报。

## 完工要求

- 提交前**必须逐条执行验收标准里的命令/检查**，把实际输出结果写进报告，不许只声明"应该没问题"。
- 不要改动规格要求之外的代码；顺手发现的其他问题写进「遗留问题」，不要自作主张修。
- 最终消息必须是如下格式的完工报告（Claude 依赖这个格式验收）：

```markdown
## 完工报告
**状态**: 完成 / 部分完成 / 受阻
**改动文件**:
- path/to/file — 一句话说明改了什么
**自测结果**:
- <验收标准第1条>: 通过/失败 + 关键输出
**假设与遗留问题**:
- <做过的假设、发现但未处理的问题、需要 Claude/用户决策的事项；没有则写"无">
```
