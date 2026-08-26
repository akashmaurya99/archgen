# Programmatic Context Injection into Agentic IDE Chat Boxes — Technique Catalog

**Project:** archgen · **Compiled:** 2026-08-26 · **Method:** ultraresearch swarm — 5 librarian agents (~100 distinct web queries: official docs, vendor forums, GitHub issues, security research) + orchestrator code-search lane over indexed GitHub sources. Every claim carries a link; ⚠️ marks single-source or unverifiable claims. **No ranking applied** (per brief); reliability tiers are evidence descriptions only.

**Terminology:** *auto-send* = text lands in the chat input AND submission fires; *pre-fill* = text lands in the input, user presses Enter.

---

## Family 1 — Official workbench commands (`workbench.action.chat.open` family)

### Mechanism
VS Code's chat view exposes an **undocumented but internally heavily used** command. Decisive semantics in [`src/vs/workbench/contrib/chat/browser/actions/chatActions.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts):

```ts
export const CHAT_OPEN_ACTION_ID = 'workbench.action.chat.open';

export interface IChatViewOpenOptions {
    query: string;
    isPartialQuery?: boolean;   // true → setInput() PRE-FILL; false/default → acceptInput() AUTO-SEND
    mode?: ChatModeKind | string;            // 'ask' | 'edit' | 'agent' | custom
    attachFiles?: (URI | { uri: URI; range: IRange })[];
    attachScreenshot?: boolean;
    previousRequests?: IChatViewOpenRequestEntry[];  // seed synthetic history
    toolIds?: string[]; toolsInclude?: string[]; toolsExclude?: string[];
    modelSelector?: ILanguageModelChatSelector;      // throws if no match
    blockOnResponse?: boolean;   // promise resolves at terminal response state
    preserveInput?: boolean;     // submit without clobbering user's draft
}
// run(): bare string arg === { query: arg }
```

**Auto-send by default.** `isPartialQuery: true` is the sanctioned "type but don't press Enter". Confirmed by PR [#263458](https://github.com/microsoft/vscode/pull/263458) (`acceptInput` vs `setInput`; only `acceptInput` re-parses `/slash` commands), [vscode-discussions #2480](https://github.com/microsoft/vscode-discussions/discussions/2480), and a Cursor forum thread confirming fork parity ([forum.cursor.com/t/is-it-possible-to-submit-chat-programmatically/157654](https://forum.cursor.com/t/is-it-possible-to-submit-chat-programmatically/157654)). Identical `{query, isPartialQuery}` shape at tag [`1.88.0`](https://github.com/microsoft/vscode/blob/1.88.0/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts) — de-facto stable since mid-2024 despite absence from the official [Built-in Commands reference](https://code.visualstudio.com/api/references/commands).

Sibling ids (same file): `workbench.action.chat.newChat`, `.newEditSession`, `.toggle`, `.focusInput` (**`f1:false`**, hidden from palette, acts only on `lastFocusedWidget`), `chat.action.focus`, `.openInEditor`, `.openInNewWindow`, `.clearHistory`, mode variants generated as `` `workbench.action.chat.open${Mode}` `` → `openAsk` / `openAgent` / `openEdit`, plus `workbench.action.chat.openagent` (newer casing; [vscode-mssql constants](https://github.com/microsoft/vscode-mssql/blob/main/extensions/mssql/src/constants/constants.ts) pins both new + legacy spellings). ⚠️ No plain `workbench.action.chat.focus` exists.

### Code sketch
```ts
// Auto-send an agent task (VS Code Copilot Chat)
await vscode.commands.executeCommand('workbench.action.chat.open', {
  query: taskDescription,
  mode: 'agent',
  attachFiles: [Uri.file(problemPath)],
});
// Pre-fill only:
await vscode.commands.executeCommand('workbench.action.chat.open',
  { query: taskDescription, isPartialQuery: true });
```

### Evidence — real-world consumers
| Consumer | What it does | Link |
|---|---|---|
| VS Code core | `/init` → `{mode:'agent', query:'/init', isPartialQuery:false}`; welcome `@vscode ` partial; CLI `code chat` maps args to `{query, mode, attachFiles}` | [chatActions.ts:1331](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts), [helpActions.ts:348](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/actions/helpActions.ts), [chat.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/electron-browser/chat.contribution.ts) |
| Built-in Copilot ext | `github.copilot.chat.explain` → auto-send `{query}`; review threads seed `previousRequests`; inline chat `'vscode.editorChat.start' {message, autoSend:true}` | [inlineChatCommands.ts](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/inlineChat/vscode-node/inlineChatCommands.ts) |
| GitHub Pull Requests | Constants `OPEN_CHAT` / `NEW_CHAT` | [executeCommands.ts](https://github.com/microsoft/vscode-pull-request-github/blob/main/src/common/executeCommands.ts) |
| MongoDB for VS Code | Options type explicitly modeled on `IChatViewOpenOptions` | [participantTypes.ts](https://github.com/mongodb-js/vscode/blob/main/src/participant/participantTypes.ts) |
| vscode-comment-translate | `{'@translate ' + text}` auto-send | [file.ts:143](https://github.com/intellism/vscode-comment-translate/blob/master/src/command/file.ts) |
| maestro | Per-IDE branches: same call on VS Code **and Cursor** w/ try/catch fallback | [extension.ts:271](https://github.com/sharpdeveye/maestro/blob/main/maestro-extension/src/extension.ts) |
| vscode-front-matter | `newChat` → `openagent {query, attachFiles}` with `chat.open` fallback | [DataListener.ts:182](https://github.com/estruyf/vscode-front-matter/blob/main/src/listeners/panel/DataListener.ts) |
| vscode-cosmosdb | Migration phases dispatch full prompts in agent mode | [phase1Discovery.ts:216](https://github.com/microsoft/vscode-cosmosdb/blob/main/src/panels/migration/steps/phase1Discovery.ts) |
| github-copilot-api-vscode | `{query, isPartialQuery:false}` after readiness probe | [extension.ts:519](https://github.com/suhaibbinyounis/github-copilot-api-vscode/blob/main/src/extension.ts) |
| TaskSync | `startFreshCopilotChatWithQuery()` = newChat → open | [chatSessionUtils.ts](https://github.com/4regab/TaskSync/blob/main/tasksync-chat/src/utils/chatSessionUtils.ts) |

Maintainer posture: no public API to inject into the *active* session's input/attachments ([discussion #3080](https://github.com/microsoft/vscode-discussions/discussions/3080): "no public API … to prevent extensions from polluting the user's chat"); variable syntax inside `query` unparsed, closed out-of-scope with "there is currently no alternative" ([#210819](https://github.com/microsoft/vscode/issues/210819)); `variableIds` partially landed ([#233108](https://github.com/microsoft/vscode/issues/233108)); open FR for deeper programmatic chaining (`copilot.chat.runPrompt`) ([#301044](https://github.com/microsoft/vscode/issues/301044)); scheduled/programmatic requests blocked by protected-tool invocation tokens ([discussion #2724](https://github.com/microsoft/vscode-discussions/discussions/2724)).

### IDE-support matrix
| VS Code | Cursor | Windsurf | Void | Trae | Kiro | Zed |
|---|---|---|---|---|---|---|
| ✅ strong | ⚠️ partial | ❓ unverified | ✅ inherited | ❓ unverified | ❓ unverified | ❌ N/A |

- **Cursor:** fork retains the command; fill-not-send parity confirmed (forum thread above); maestro ships a Cursor branch. But Composer-era internals diverge: internal `composer.updateTitle/updateStatus/renameChat` **reject programmatic calls with "Canceled"**, and `workbench.action.devGetComposerDataForTesting` is gated behind `--enable-smoke-test-driver` ([forum: title/status FR](https://forum.cursor.com/t/let-agents-set-their-own-chat-title-status-programmatically-e-g-dev-active/166385)).
- **Void:** fork source retains identical chat action/focus ids ([chatAccessibilityHelp.ts](https://github.com/voideditor/void/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatAccessibilityHelp.ts), [extHostUrls.ts](https://github.com/voideditor/void/blob/main/src/vs/workbench/api/common/extHostUrls.ts)); repo archived Jun 2 2026.
- **Windsurf/Trae/Kiro:** VS Code-family forks so inheritance is plausible, but no public evidence found (absence-of-evidence).
- **Zed:** not VS Code-based; N/A.

### Reliability: **HIGH on VS Code** (Microsoft's own shipped extensions use it across ≥2 years); **MEDIUM on forks** (ids drift; Cursor's composer internals actively resist programmatic control).

---

## Family 2 — Host extensibility APIs (participants & Language Model API)

### Mechanism
Two stable APIs since **1.90** (finalized July 2024, announced in [#206265](https://github.com/microsoft/vscode/issues/206265)):
- `vscode.chat.createChatParticipant(id, handler)` — your extension *receives* prompts; it **cannot** push text into another participant's input ([guide](https://code.visualstudio.com/api/extension-guides/ai/chat)).
- `vscode.lm.selectChatModels()` / `LanguageModelChat.sendRequest()` — direct model access that **bypasses the chat UI entirely** ([guide](https://code.visualstudio.com/api/extension-guides/ai/language-model)); user-consent dialog required for Copilot models.

```ts
const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
```

Proposed/private surface: `chatParticipantPrivate` (dynamic participants, session lifecycle — vendored privately by Copilot Chat: [d.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts), [vscode-copilot-chat copy](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7/src/extension/vscode.proposed.chatParticipantPrivate.d.ts)); `chatProvider` BYOK provider API — shipped per [BYOK blog (v1.104)](https://code.visualstudio.com/blogs/2025/10/22/bring-your-own-key) yet publish-blocked per maintainer Aug 2025 ([#263522](https://github.com/microsoft/vscode/issues/263522)) ⚠️ tension unresolved; built-in Copilot edit tools blocked to third parties ([#255855](https://github.com/microsoft/vscode/issues/255855)); chat-sessions `inputState` proposal active ([PR #308630](https://github.com/microsoft/vscode/pull/308630)).

### Who uses what (the Cline/Roo/Kilo answer)
All major agent extensions chose the **LM-API bypass, never host-chat injection**: Cline [`src/core/api/providers/vscode-lm.ts`](https://github.com/cline/cline/blob/8a6441fd/src/core/api/providers/vscode-lm.ts) (+ newer `apps/vscode/src/sdk/vscode-lm/` layout, commit [6acc231](https://github.com/cline/cline/commit/6acc231da505689e18fe7dbea9aa0b0b8bed37e2)); Roo Code [`src/api/providers/vscode-lm.ts`](https://github.com/RooVetGit/Roo-Code/blob/main/src%2Fapi%2Fproviders%2Fvscode-lm.ts) with a Copilot-model blacklist; Kilo Code = Roo fork ⚠️unverified directly; Continue declined participant status ([#3692](https://github.com/continuedev/continue/issues/3692), [#2831](https://github.com/continuedev/continue/issues/2831)); Cody self-contained, no integration found ⚠️single-source absence. Corrections: "websearch-for-copilot" is Microsoft's participant/tool sample ([repo](https://github.com/microsoft/vscode-websearchforcopilot)); Prompt Boost is pure LM+tool ([chrisdias/vscode-promptboost](https://github.com/chrisdias/vscode-promptboost)) — neither touches the input box.

### Matrix: VS Code ✅ (stable API) · forks inherit where they ship Copilot · Zed ❌.
### Reliability: **HIGH for model access; NOT an injection channel** (by design).

---

## Family 3 — Runtime command enumeration

### Mechanism
`vscode.commands.getCommands(filterInternal?)` returns every registered id (underscore-prefixed = internal, only with `true`). Probe at runtime instead of hardcoding:

```ts
const cmds = await vscode.commands.getCommands();
const hasCopilotChat = ['github.copilot.interactiveEditor.explain', 'github.copilot.sendChatToTerminal']
  .some(c => cmds.includes(c));
const chatCmds = cmds.filter(id => /chat|copilot/i.test(id));
```

Real implementations: prompt-manager capability probe + 3-method cascade ([VSCodeIntegrationService.ts](https://github.com/cursor-project/prompt-manager/blob/main/src/services/VSCodeIntegrationService.ts)) ⚠️single-source; existence-check pattern in VSCodeVim ([vimrc.ts:32](https://github.com/VSCodeVim/Vim/blob/master/src/configuration/vimrc.ts)) and Dendron ([_extension.ts:208](https://github.com/dendronhq/dendron/blob/master/packages/plugin-core/src/_extension.ts)); discovery palettes: [usernamehw/vscode-commands](https://github.com/usernamehw/vscode-commands) (`quickPickIncludeAllCommands` surfaces palette-hidden commands); SO recipes ([71467095](https://stackoverflow.com/questions/71467095/how-to-list-all-commands-related-to-a-specific-extension-in-vs-codes-command-pa), [58367207](https://stackoverflow.com/questions/58367207/list-of-all-available-commands-in-vscode)). Reverse-engineering tooling for the Copilot bundle: [copilot-explorer](https://thakkarparth007.github.io/copilot-explorer/).

Caveat: ids churn — naming inconsistency admitted by maintainers ([#190893](https://github.com/microsoft/vscode/issues/190893)); mode-open commands became **focus-conditionally dynamically registered** in 1.121.0 ([#318168](https://github.com/microsoft/vscode/issues/318168)); keybinding-targetable ids silently removed ([vscode-copilot-release #1207](https://github.com/microsoft/vscode-copilot-release/issues/1207), [#267274](https://github.com/microsoft/vscode/issues/267274)). ⚠️ No published version-by-version diff of Copilot internal command ids exists.

### Matrix: works wherever the extension host runs (all VS Code-family forks; Zed N/A).
### Reliability: **HIGH as a discovery layer**; discovered ids themselves MEDIUM stability.

---

## Family 4 — Clipboard bridge

### Mechanism
Extension host has **no keyboard API** (feature request open since 2020: [#104832](https://github.com/microsoft/vscode/issues/104832); confirmed impossible in [SO 66479742](https://stackoverflow.com/questions/66479742/simulate-user-keystrokes-in-visual-studio-code-extension-testing), [SO 72589442](https://stackoverflow.com/questions/72589442/how-to-call-a-shortcut-inside-a-vs-code-extension-by-api)). Bridge: save clipboard → focus chat input via command → sleep → write clipboard → `editor.action.clipboardPasteAction` → restore. Paste sidesteps IME composition entirely (advantage over typing).

Canonical production sequence (Cursor; staff confirm "not officially unfortunately, but you may be able to hack around"): [forum.cursor.com/t/adding-text-to-chat-from-extension/43555](https://forum.cursor.com/t/adding-text-to-chat-from-extension/43555)

```ts
const saved = await vscode.env.clipboard.readText();
await vscode.commands.executeCommand('aichat.show-ai-chat');       // Cursor chat focus
await new Promise(r => setTimeout(r, 500));                        // race guard
await vscode.env.clipboard.writeText(taskDescription);
await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
await vscode.env.clipboard.writeText(saved);
```

Full automation incl. simulated Enter via external process — prompt-tower ([EditorAutomationService.ts](https://github.com/backnotprop/prompt-tower/blob/main/src/services/EditorAutomationService.ts)) ⚠️single-source: clipboard → `composer.newAgentChat` (Cursor) / `workbench.action.chat.open` (VS Code) → 375 ms → paste → 750 ms → `osascript -e 'tell application "System Events" to keystroke return'`, with Accessibility-permission error detection; macOS-only. Capability-probing cascade: prompt-manager (above). Other real users: SocratiCode (clipboard + `chat.open` in try/catch because "some Theia-based forks omit it" — [commands.ts](https://github.com/giancarloerra/SocratiCode/blob/main/extension/src/commands.ts)); microsoft/agent-governance-toolkit Cursor ext (clipboard + `cursorChat.focus` + quickOpen fallback — [extension.ts](https://github.com/microsoft/agent-governance-toolkit/blob/main/agent-governance-python/agent-os/extensions/cursor/src/extension.ts)); manual-paste fallers-back: Cotalker ([marketplace](https://marketplace.visualstudio.com/items?itemName=ntson9p.cotalker)), Voice2Copilot ([marketplace](https://marketplace.visualstudio.com/items?itemName=AvenirNumerique.voice2copilot-vscode)), Prompts Chat ([repo](https://github.com/Lin-jun-xiang/vscode-prompts-chat-extension)), CodeWebChat ([run-generate-action.ts](https://github.com/robertpiosik/CodeWebChat/blob/dev/apps/editor/src/commands/generate-commit-message-commands/actions/run-generate-action.ts)).

Focus-command toolbox: `workbench.action.chat.focusInput` (hidden; no-op if no chat widget ever focused), `workbench.panel.chat.view.copilot.focus` ([SO 77896807](https://stackoverflow.com/questions/77896807/is-there-a-shortcut-to-focus-to-the-github-copilot-chat-panel-in-vscode)), `github.copilot.chat.focus` ⚠️single-source ([iifx guide](https://iifx.dev/en/articles/456607637/boost-your-productivity-keyboard-shortcut-guide-for-toggling-copilot-chat-sidebar)); stale `focusedView` context key bug [#198293](https://github.com/microsoft/vscode/issues/198293).

Timing races are structural: `setInput` must await viewModel restore "or it will be cleared when the model is restored"; `waitForDefaultAgent` races a 60 s timeout ([chatActions.ts source comments](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts)); `newChat` no-ops on first invocation of a fresh session ([#261118](https://github.com/microsoft/vscode/issues/261118)); practitioners use 300–750 ms sleeps.

### Matrix: VS Code ✅ · Cursor ✅ (different focus ids) · Windsurf/Trae/Kiro ❓ (fork-dependent ids) · Void ✅ likely · Zed ❌.
### Reliability: **MEDIUM** — replicated across ≥6 independent projects, but racy, mutates user clipboard, focus commands have documented no-op modes.

---

## Family 5 — Webview-side synthetic events (dead end, one patched exception)

### Mechanism & verdict
`dispatchEvent(new KeyboardEvent(...))` fires listeners but performs **no default action** (`isTrusted === false`) — verified independently ([SO-for-Agents TIL](https://agents.stackoverflow.com/tils/fa3eac2b-bda6-4423-b427-5932dc085ed7)); rich editors filter untrusted input (Lexical: [dev.to analysis](https://dev.to/snake_sun/why-reddit-indiehackers-and-twitter-lexical-editors-block-programmatic-input-3d76); ProseMirror caret movement: [cmux#2653](https://github.com/manaflow-ai/cmux/issues/2653)). Trusted events require CDP-level injection — unavailable to an extension host. Webview and workbench chat input live in **separate renderer processes**; `document.execCommand('insertText')` only affects its own document ([ProseMirror filling guide](https://dev.to/vesper_finch/how-i-defeated-prosemirror-the-only-way-to-programmatically-insert-text-into-rich-text-editors-1208)); Electron dropped `execCommand("paste")` outright ([#239228](https://github.com/microsoft/vscode/issues/239228)). Even within a webview, dispatched KeyboardEvents fail on Windows ([#109147](https://github.com/microsoft/vscode/issues/109147)).

**The exception that proves the rule:** VS Code relayed webview `did-keydown` messages into main-frame keybinding handling — security issue ([#319593](https://github.com/microsoft/vscode/issues/319593)) fixed by PR [#319704](https://github.com/microsoft/vscode/pull/319704) (milestone 1.124). Plannotator deliberately exploited this channel pre-fix ([PR #970](https://github.com/backnotprop/plannotator/pull/970)). Do not build on it.

Renderer-console angle: chat DOM readable from DevTools console ([OZORDI gist](https://gist.github.com/OZORDI/ecba553750991d5407a5735b9de65e40)) but `vscode.*` APIs don't exist there (extension-host only — [Cursor forum follow-up](https://forum.cursor.com/t/adding-text-to-chat-from-extension/43555)); hostile renderer takeover is demonstrably sufficient, which is exactly why extensions aren't given it ([Knostic](https://www.knostic.ai/blog/demonstrating-code-injection-vscode-cursor)).

### Matrix: ❌ everywhere (post-1.124). Reliability: **N/A — structurally closed.**

---

## Family 6 — Chrome DevTools Protocol attach to the renderer

### Mechanism
Electron renderers honor Chromium's `--remote-debugging-port`. Launch (or relaunch) the IDE with the flag, attach Playwright/Puppeteer over CDP, drive the chat DOM with **trusted** events.

**Definitive reference — Microsoft's own agent skill** in the vscode repo, [`.agents/skills/launch`](https://github.com/microsoft/vscode/tree/main/.agents/skills/launch) (mirror text: [mcpservers.org](https://mcpservers.org/agent-skills/microsoft/vscode/launch)):
- launches Code OSS with `--remote-debugging-port` (+ `--inspect-extensions/--inspect/--inspect-agenthost`), waits for the renderer CDP endpoint;
- drives UI via `npx @playwright/cli attach --cdp=http://127.0.0.1:$CDP`;
- **Monaco quirk:** "`fill` and `type` silently fail … Monaco's native-edit-context element doesn't react to Playwright's default input pipeline" → `monaco-paste.sh` dispatches `ClipboardEvent('paste')` with DataTransfer payload into the focused editor;
- selectors: `.interactive-input-editor .view-line` (sidebar chat); Agents window: `.native-edit-context, textarea.inputarea`;
- forces `files.simpleDialog.enable: true` (native dialogs unreachable over CDP), `--disable-workspace-trust`, per-instance `--shared-data-dir`; ⚠️ >2–3 concurrent instances hit macOS Crashpad failures.

Production CDP automation against **Cursor** (working as of Mar 2026): [len5ky/CursorRemote](https://github.com/len5ky/CursorRemote) — "Cursor IDE runs with `--remote-debugging-port=9222`; Relay Server connects via CDP, extracts agent chat state from the DOM"; sends messages, switches mode/model, Telegram client; fork [tmac14/CursorRemote-Active](https://github.com/tmac14/CursorRemote-Active). MCP-flavored variant: [pandaxbacon/cursor-bridge-mcp](https://github.com/pandaxbacon/cursor-bridge-mcp) (`cursor_send_message(target, text, submit=true)` via CDP DOM automation; warns selectors break on updates). Arbitrary-JS bridge: [im-sampm/vscode-automation-mcp](https://github.com/im-sampm/vscode-automation-mcp) (`vscode_execute_script` = "like DevTools console"). Playwright officially supports attaching to "Electron apps exposing CDP" ([attach docs](https://playwright.dev/agent-cli/commands/attach), [WebView2 guide](https://playwright.dev/docs/webview2)).

Counter-evidence & limits: antigravity-autopilot's author claims CDP breaks when "Electron disables remote debugging ports / corporate port blocks" ([vscode#302362 comment](https://github.com/microsoft/vscode/issues/302362)) ⚠️single-source framing — no independent report of stock Cursor/Windsurf stripping the flag; Cursor's *built-in* browser pane likely has no debug port ([chrome-devtools-mcp#559](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/559)); Chrome-136 default-profile restriction is context only ([developer.chrome.com](https://developer.chrome.com/blog/remote-debugging-port)). **Windsurf: zero public CDP evidence found (gap)** — its community driver chose AppleScript instead.

### Code sketch
```bash
/Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=9222 &
# verify: curl http://localhost:9222/json
```
```ts
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = /* locate workbench page */;
await page.focus('.interactive-input-editor');
await page.evaluate(() => {           // Monaco ignores fill/type — must paste:
  const dt = new DataTransfer(); dt.setData('text/plain', TASK);
  document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
});
await page.keyboard.press('Enter');   // trusted send
```

### Matrix: VS Code ✅ (MS-internal workflow) · Cursor ✅ (proven Mar 2026) · Windsurf ❓ no evidence · Void/Trae/Kiro ❓ (Electron forks, expected to work) · Zed ⚠️ different stack (GPUI, no CDP).
### Reliability: **HIGH when you control launch flags; MEDIUM operationally** (app relaunch required, selector brittleness, Monaco paste-event requirement, multi-client conflicts).

---

## Family 7 — External OS-level automation

### 7a. macOS — AppleScript / System Events / Hammerspoon / AX tree
- Real drivers targeting Cursor: [terryso/cursor_remote `send_chat.scpt`](https://github.com/terryso/cursor_remote/blob/develop/scripts/send_chat.scpt) (clipboard → activate → System Events keystroke); [ddhjy/chat-any](https://github.com/ddhjy/chat-any/blob/main/src/common.ts) (`open -a Cursor` + System Events key codes); [Strajk/setup `cursor.lua`](https://github.com/Strajk/setup/blob/main/home/.hammerspoon/cursor.lua) (Hammerspoon eventtap; documents positional fragility: "downPresses count depends on the order of models… adjust if the list changes"); [2mawi2/cursor-auto-accept](https://github.com/2mawi2/cursor-auto-accept) (Cmd+Return every 2 s); [MindSyncTech/talk-to-cursor](https://github.com/MindSyncTech/talk-to-cursor) (AX-monitored auto-submit).
- Reliability canon: AppleScript reports **0 windows** for Electron and `keystroke` is unreliable vs `key code`; switch IME to ABC before typing ([window-pilot](https://github.com/window-pilot/window-pilot)); TCC Accessibility/Input-Injection grants expire after app updates ([Apple Community](https://discussions.apple.com/thread/255165673)); `CGEvent.post()` silently no-ops in App Sandbox — NSAppleScript workaround ~80–100 ms ([QUICOPY](https://dev.to/quicopy/shipping-global-keyboard-shortcuts-on-macos-sandbox-the-part-apple-doesnt-document-57no)); CGEvent Cmd+V fails in Chrome-class apps even when posted ([FluidVoice research](https://github.com/jonathanglasmeyer/FluidVoice/blob/master/docs/cgevent-paste-research.md)); Secure Input blocks synthesis globally ([Apple dev forums](https://developer.apple.com/forums/thread/726353)).
- **AX-tree lane (most future-proof macOS option):** Electron exposes web content to AT only after the client sets `AXManualAccessibility` ([official docs](https://electronjs.org/docs/latest/tutorial/accessibility)); real consumers: [openwork AccessibilityService.swift](https://github.com/different-ai/openwork/blob/dev/packages/handsfree/native/HandsFree/Sources/ComputerUse/AccessibilityService.swift), [Automattic/harper](https://github.com/Automattic/harper/blob/master/harper-desktop/src-tauri/src/mac_broker/accessibility_activation.rs), [screenpipe](https://github.com/screenpipe/screenpipe/blob/main/crates/screenpipe-a11y/examples/macos_weburl_probe.rs), [SyncClipboard caret provider ("required for apps like VSCode")](https://github.com/Jeric-X/SyncClipboard/blob/master/src/SyncClipboard.Desktop.MacOS/Utilities/CaretPositionProvider.cs). Tree is lazy until an AT announces itself ([SO 77414905](https://stackoverflow.com/questions/77414905/how-can-i-get-axuielement-if-its-role-is-axwebarea)). Stability argument: "AXUIElement + AXPress on Electron buttons survives version bumps because the accessibility tree is a stable contract"; pitfalls = AXRaise focus theft, stale AXChildren after React re-renders, detached AXWindow dialogs → subscribe to AXCreated notifications ([m13v in vscode#302362](https://github.com/microsoft/vscode/issues/302362)).

### 7b. Linux — xdotool
- Canonical VS Code failure + fix: `--window` targeting uses XSendEvent which Chromium ignores; must `windowactivate --sync` then plain XTEST key ([SO 34755584](https://stackoverflow.com/questions/34755584/vs-code-does-not-respond-to-input-from-xdotool), [xdotool manpage SENDEVENT NOTES](https://manpages.ubuntu.com/manpages/trusty/man1/xdotool.1.html)). Dead on Wayland — use ydotool/dotool ([xdotool README](https://github.com/jordansissel/xdotool)). Production voice-driver pipeline against VS Code/Cursor: clipboard-paste primary + windowactivate-before-paste ([Rota-AI](https://github.com/krthik20050/Rota-AI)) ⚠️single-source internals. IME hazard demonstrated: ibus engine switch required before xdotool focus+type ([stablyai/orca e2e test](https://github.com/stablyai/orca/blob/main/tests/e2e/terminal-ibus-hangul-native.spec.ts)).

### 7c. Windows — SendKeys / SendInput / UIA
- No public AHK script driving Cursor chat found (gap); AHK's own docs warn background windows "just won't accept keystrokes" ([forum t=82195](https://www.autohotkey.com/boards/viewtopic.php?style=7&t=82195)). `SendInput` fails **silently** under UIPI ([MS Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)).
- What Windows drivers actually use: **UI Automation** — [timteh/antigravity-autopilot](https://github.com/timteh/antigravity-autopilot) auto-clicks Accept/Run/Continue via `InvokePattern.Invoke()` "across VS Code, Cursor, Windsurf, and Antigravity… works even when Electron disables remote debugging ports" ([disclosed in vscode#302362](https://github.com/microsoft/vscode/issues/302362)); hybrid cascades: [Computer_Use_Agents](https://github.com/manishmcsa01-cmd/Computer_Use_Agents) (hotkeys → pywinauto UIA → vision → CDP-for-Electron); PostMessage WM_CHAR-per-char + SendKeys hybrid ([stablyai/orca runtime.ps1](https://github.com/stablyai/orca/blob/main/native/computer-use-windows/runtime.ps1)); UIA inspection MCP aimed at Copilot clients ([trsdn/mcp-server-uiautomation](https://marketplace.visualstudio.com/items?itemName=trsdn.uia-mcp)).

### 7d. Node keyboard libs from a spawned helper
robotjs: long-dormant reputation ([LibHunt](https://nodejs.libhunt.com/compare-nut-js-vs-robotjs)) but revived Aug 2026 (npm 0.9.1 published days prior; maintainer triaging issues Mar 2026) — trust deficit persists ([RemoteMouse#42](https://github.com/harshal-mehta-code/RemoteMouse/issues/42)). nut.js v5.x: maintained; adds macOS accessibility **event monitoring** (`treeChanged/valueChanged/focusChanged`), element inspector (`window.find(elements.Button("Submit"))`), permission check/request API; Node ≥22, macOS ≥14; parts commercially licensed ([changelog](https://nutjs.dev/changelog/core)). Real paste-and-send pattern: `keyTap('v', ['command'|'control'])` then `keyTap('enter')` ([sightflow-desktop-agent](https://github.com/sightflow-dev/sightflow-desktop-agent/blob/main/src/core/rpa/input-utils.ts)); clipboard+keyTap+Enter in production ([awakened-poe-trade](https://github.com/SnosMe/awakened-poe-trade/blob/master/main/src/shortcuts/text-box.ts)); cross-platform driver references: elizaOS computer-use backends (cliclick/AppleScript · xdotool · P/Invoke) ([plugin-computeruse](https://github.com/elizaOS/eliza/blob/develop/plugins/plugin-computeruse/src/platform/desktop.ts)).

### Matrix
| Lane | VS Code | Cursor | Windsurf | Void/Trae/Kiro | Zed |
|---|---|---|---|---|---|
| AppleScript/System Events | ✅ fg | ✅ fg | ✅ fg (wsc proven) | ✅ fg | ✅ fg |
| xdotool (X11) | ✅ | ✅ | ❓ | ✅ | ✅ |
| SendKeys/SendInput | ⚠️ UIPI | ⚠️ UIPI | ⚠️ UIPI | ⚠️ | ⚠️ |
| Windows UIA Invoke | ✅ | ✅ | ✅ (claimed) | ✅ | ✅ |
| macOS AX (AXManualAccessibility) | ✅ | ✅ | ✅ | ✅ | ⚠️ non-Electron |

(fg = requires foreground; wsc = staronelabs/windsurf-cli, see Family 10.)

### Reliability: **MEDIUM overall** — version-proof (no internal APIs touched) but foreground-hungry, permission-gated, IME-sensitive; AX/UIA lanes rate **MEDIUM-HIGH** for button-level control, LOW-MEDIUM for free-text entry.

---

## Family 8 — Deep links & URI handlers

### VS Code machinery
[`window.registerUriHandler`](https://code.visualstudio.com/api/references/vscode-api#window.registerUriHandler) + `onUri` activation; grammar `vscode://<publisher>.<extension>/path?query` — authority **must be your extension id** ([activation-events](https://code.visualstudio.com/api/references/activation-events)). **No arbitrary command passthrough exists**: `vscode.command://` returns zero hits in the wild (checked); `command:` URIs execute only inside trusted contexts with explicit allowlists — `MarkdownString.isTrusted: { enabledCommands: [...] }` ([htmlContent.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/htmlContent.ts)), webview `enableCommandUris: boolean|string[]` ([PR #163501](https://github.com/microsoft/vscode/pull/163501/files)); `_workbench.downloadResource` always blocked ([markdownRenderer.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/markdownRenderer.ts)).

Real deep-link receivers (pattern proof): Copilot `vscode://github.copilot-chat?mode=agent` ([chatSetup.ts L1149](https://github.com/microsoft/vscode/blob/d65071909487b9159e08726c57adf5eb008d7d3a/src/vs/workbench/contrib/chat/browser/chatSetup.ts#L1149), [#252595](https://github.com/microsoft/vscode/issues/252595)), core promptUrlHandler ([source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/promptSyntax/promptUrlHandler.ts)), ChatSessionsUriHandler with cross-window `.pendingSession` file handoff ([source](https://github.com/microsoft/vscode/blob/main/extensions/copilot/src/extension/chatSessions/vscode/chatSessionsUriHandler.ts), PRs [#1481](https://github.com/microsoft/vscode-copilot-chat/pull/1481)/[#1595](https://github.com/microsoft/vscode-copilot-chat/pull/1595)); GitLens DeepLinkService browser→IDE redirect ([deepLinkService.ts](https://github.com/gitkraken/vscode-gitlens/blob/main/src/uris/deepLinks/deepLinkService.ts)); CodeTour `/starTour?tour=&step=` ([CHANGELOG](https://github.com/microsoft/codetour/blob/main/CHANGELOG.md)); remote handoff `vscode://vscode-remote/ssh-remote+host/path` ([#10077](https://github.com/microsoft/vscode-remote-release/issues/10077)).

**archgen-relevant:** your own extension can register a uriHandler so a companion web app / CI badge fires `vscode://your.publisher.archgen/start?task=...` → your extension then injects via Family 1/4. This is the standard sanctioned handoff.

### Vendor schemes
- **`cursor://anysphere.cursor-deeplink/prompt?text=…`** — official: opens Cursor with prompt **pre-filled**; "The user must review and confirm… Deeplinks never trigger automatic execution"; 8,000-char cap; web mirror `https://cursor.com/link/prompt?text=` ([Deeplinks reference](https://cursor.com/docs/reference/deeplinks)). Undocumented params in production code: `&workspace=<basename>&mode=agent`, and **`text` must be double-encoded** ("Cursor's router does two decode passes") ([inkeep/open-knowledge cursor-url.ts](https://github.com/inkeep/open-knowledge/blob/main/packages/core/src/handoff/cursor-url.ts), corroborated by [InsForge usage](https://github.com/InsForge/InsForge/blob/main/packages/dashboard/src/features/dashboard/components/dtest/DTestMCPSection.tsx)). Also `/command?name&text`, `/mcp/install?config=<base64>` ([install links](https://cursor.com/docs/mcp/install-links)), `/background-agent?bcId=`, `/createchat?data=<JWT>` (BugBot; undocumented — [forum request refused](https://forum.cursor.com/t/request-for-deep-linking-api-documentation-for-quick-open-from-browser/110507)). Security history: CVE-2025-54136 "CurXecute" + CVE-2025-54133 ([Proofpoint](https://www.proofpoint.com/us/blog/threat-insight/cursorjack-weaponizing-deeplinks-exploit-cursor-ide)); dialog-truncation primitive still worked on Cursor 3.4.20/3.9.8 per Adversa July 2026 ([DeepJack](https://adversa.ai/blog/cursor-security-deepjack-deeplink-vulnerability-mcp-rce)).
- **`windsurf://cascade/newChat?folder=…&prompt=…&autoRun=true`** — pre-fills Cascade; **`autoRun` does not execute** ([Exafunction/codeium#283](https://github.com/Exafunction/codeium/issues/283), Feb 2026) ⚠️single-source; grammar undocumented by vendor (only `windsurf://windsurf-mcp-registry?serverName=` appears in [docs](https://docs.devin.ai/desktop/cascade/mcp)); post-rebrand `devin://acp` handler observed in login flow ([#336](https://github.com/Exafunction/codeium/issues/336)).
- **`kiro://kiro.resume-session/<base64>`** — undocumented handler that auto-extracts an attacker ZIP without interaction; researcher gist, AWS closed "informative"; relates to CVE-2026-4295 ([gist](https://gist.github.com/usualdork/dc8e708eff0047a244f174d5cfa2b4ff)) ⚠️single-source.
- Survey table of other schemes (`codex://threads/new`, `qoder://aicoding.aicoding-deeplink/mcp/add`, zed "no exec route"): [adversa.ai table](https://adversa.ai/blog/cursor-security-deepjack-deeplink-vulnerability-mcp-rce); community registry listing `windsurf://` with `supportsQuerystring:false` ([prompts.chat platforms.ts](https://github.com/f/prompts.chat/blob/main/packages/prompts.chat/src/cli/platforms.ts)).

### Matrix: VS Code ✅ (self-registered handlers; Copilot handlers exist) · Cursor ✅✅ (only vendor with a sanctioned prompt deeplink) · Windsurf ⚠️ prefill-only · Kiro ⚠️ resume-session only · Trae ❌ none found · Zed ⚠️ `zed://` collaboration-oriented.
### Reliability: **HIGH for pre-fill delivery** (OS-routed, survives UI changes better than DOM selectors); auto-execution intentionally blocked everywhere surveyed.

---

## Family 9 — Terminal channel: agent CLIs as the injection target

Instead of fighting the chat UI, spawn the vendor's own agent CLI in the integrated terminal (or a pty) with the task as an argument. Verified matrix:

| CLI | Non-interactive | Interactive w/ initial prompt | Resume | Doc |
|---|---|---|---|---|
| Claude Code | `claude -p "q"` (`--print`, stdin ok) | `claude "q"` positional | `-c`, `-r <id> [q]`, `--fork-session` | [cli-reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless) |
| Codex CLI | `codex exec "PROMPT"`; `codex exec -` = stdin | TUI positional ⚠️single-source | `codex exec resume --last`, `codex resume` | [noninteractive](https://developers.openai.com/codex/noninteractive) |
| Cursor Agent | `agent -p "…"` (+`--force/--yolo` to edit; `--trust` newer-builds-only ⚠️) | positional starts interactive | `--resume [id]`, `--continue` | [parameters](https://cursor.com/docs/cli/reference/parameters) |
| Gemini CLI | `gemini -p "q"` | positional→interactive (recent change); `-i/--prompt-interactive` | `--resume/--session-id/--session-file` | [headless.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md) |
| aider | `-m/--message`, `-f/--message-file`, `--yes-always` | positional message | `/load`, `--load` | [scripting](https://aider.chat/docs/scripting.html) |
| opencode | `opencode run [msg..]` | bare `opencode "msg"` | `-c`, `-s`, `--fork` | [cli](https://opencode.ai/docs/cli/) |
| Goose | `goose run -t "task"`; `-i FILE\|-`; `--recipe`; `--no-session` | add `-s/--interactive` | `-r`, `--session-id` | [goose-cli-commands](https://github.com/block/goose/blob/main/documentation/docs/guides/goose-cli-commands.md) |
| Crush | `crush run [prompt…]` | ❌ none found | `-C`, `-s ID` | [crush run](https://charmbracelet-crush.mintlify.app/cli/run) |
| Amazon Q / kiro-cli | `kiro-cli chat --no-interactive "…"`; stdin pipe ends after reply ([#798](https://github.com/aws/amazon-q-developer-cli/issues/798)) | `q chat [INPUT]` positional first question; headless IDE: `kiro --print "task"` ([headless docs](https://kiro.dev/docs/cli/headless)) | `--resume/-r`, `--resume-id` | [cli-commands](https://kiro.dev/docs/reference/cli-commands/) |
| qwen-code | `qwen -p "q"` (+`--output-format stream-json`) | positional→interactive | `--continue`, `--resume` | [headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/) |
| kimi-cli | `kimi -p TEXT` | ❌ documented none | `-S`, `-c` | [kimi-command.md](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/reference/kimi-command.md) |
| Continue | `cn -p` — designed for embedding ("TTY-less environments… called from VSCode/IntelliJ extensions") | — | — | [cli guide](https://docs.continue.dev/guides/cli) |

Corroborating spawn code: `claude -p --output-format json` ([ruflo](https://github.com/ruvnet/ruflo), [nanoclaw](https://github.com/nanocoai/nanoclaw)), positional `claude --print --model haiku "<prompt>"` ([payloadcms evals](https://github.com/payloadcms/payload/blob/main/test/evals/runner/claudeCode.ts)), `claude -p <prompt> --agent <subagent>` ([pipeline hooks](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/patterns/pipeline.ts)), `cursor-agent --output-format stream-json` + WSL-on-Windows note ([automaker](https://github.com/AutoMaker-Org/automaker/blob/main/apps/server/src/providers/cursor-provider.ts)), `--trust` capability gating ([open-design runtime defs](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/defs/cursor-agent.ts)), multi-CLI matrix comment (`copilot -p / opencode run / gemini -p / qwen -p / aider --message / goose run`) ([svelte-doctor](https://github.com/pimatis/svelte-doctor/blob/main/src/commands/fix.ts)).

Embedding precedents: official Claude Code extension bundles a private CLI copy + "Use Terminal" mode + integrated-terminal auto-detection ([docs](https://code.claude.com/docs/en/vs-code)); reverse-direction IDE-integration protocol = WebSocket MCP + `~/.claude/ide/.lock` discovery ([claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)); aider terminal spawners ([Conflate-AI](https://github.com/Conflate-AI/Aider-Smart-Context-Vscode-Ext), [Apertia.vscode-aider](https://marketplace.visualstudio.com/items?itemName=Apertia.vscode-aider), Flask-sidecar [aider-composer](https://github.com/lee88688/aider-composer)); multi-CLI terminal launcher ([maskzh/vscode-extension-claude-code](https://github.com/maskzh/vscode-extension-claude-code/tree/v0.1.3)).

### Matrix: works on every OS/host with the CLI installed — IDE-agnostic (the escape hatch for Windsurf/Trae/Kiro/Zed where UI injection is weakest). Trade-off: separate transcript/session from the native chat pane.
### Reliability: **HIGHEST of all families** — argv contracts are documented and stable; cost is UX separation from the native chat UI.

---

## Family 10 — MCP servers & agent protocols as injection layers

### Protocol verdict
MCP **cannot** push into a host chat by design: servers expose tools/resources/prompts *to* clients; server-initiated channels are sampling (**deprecated as of spec 2026-07-28**, [draft/sampling](https://modelcontextprotocol.io/specification/draft/client/sampling)) and elicitation, both client/user-mediated ([elicitation spec](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)). Every working "send prompt to IDE chat" MCP goes **out-of-band**: [cursor-bridge-mcp](https://github.com/pandaxbacon/cursor-bridge-mcp) (CDP, Family 6); command-passthrough bridges — [bestK/vscode-internal-command-mcp-server](https://github.com/bestK/vscode-internal-command-mcp-server) (extension-as-MCP-server, allowlisted `execute_vscode_command`), [tjx666/vscode-mcp](https://github.com/tjx666/vscode-mcp) (⚠️ "can execute arbitrary VSCode commands"; also ships plain CLI over Unix socket), [ivan-mezentsev/vsc-mcp](https://github.com/ivan-mezentsev/vsc-mcp); hook-mediated delivery ([agent-room-mcp](https://github.com/umbecanessa/agent-room-mcp) writes `.cursor/hooks.json`). Cursor forum confirms the gap and the SSE-workaround pattern ([thread 81342](https://forum.cursor.com/t/develop-an-extension-to-send-prompt-to-cursor-chat/81342/4)).

### Harness-native receivers
- **Claude Code hooks**: `UserPromptSubmit` receives prompt JSON on stdin and can return `hookSpecificOutput.additionalContext` or block (exit 2); `SessionStart` stdout becomes context ([hooks reference](https://code.claude.com/docs/en/hooks)).
- **OpenCode plugins**: event bus includes **`tui.prompt.append`** (append into the TUI input), mutable `tool.execute.before` args, compaction-prompt replacement ([plugins docs](https://opencode.ai/docs/plugins/)).
- **Windsurf Cascade hooks**: 12 events incl. `pre_user_prompt`, `post_cascade_response` (transcript JSONL capture); but "hooks can only block actions or log output. They cannot inject context into the conversation" ([official hooks docs](https://docs.devin.ai/desktop/cascade/hooks); limitation quote: [Axiom-Windsurf](https://github.com/detailobsessed/Axiom-Windsurf/blob/main/windsurf-agent-skills-learnings.md)) ⚠️single-source limitation quote.
- **ACP (Agent Client Protocol)** — the clean universal layer: JSON-RPC 2.0 over stdio; "send prompt" is a first-class RPC ([spec](https://agentclientprotocol.com/get-started/introduction), [zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol/)). Agents: Gemini CLI `--acp` ([config.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)), `kimi acp`, `qwen serve` (ACP daemon), `kiro-cli acp` ([clients page](https://agentclientprotocol.com/overview/clients)); Windsurf hosts "every other ACP agent" ([cascade overview](https://docs.windsurf.com/windsurf/cascade/cascade)); VS Code clients exist as extensions ([formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp) et al.). Known gap: Zed's Claude ACP lacks elicitation support — "essentially broken" claim ([zed discussion #48784](https://github.com/zed-industries/zed/discussions/48784)) ⚠️single-source; Claude-Code-via-ACP adapter widely referenced but not directly fetched this session ⚠️.

### Matrix: MCP-to-UI ❌ by design (out-of-band hybrids ✅ brittle) · hooks/plugins ✅ per-harness · ACP ✅ anywhere a compliant agent runs (Zed natively; Windsurf as host).
### Reliability: ACP **HIGH** (protocol contract); MCP bridges **LOW-MEDIUM** (selector/config fragility); hooks **HIGH within their harness**.

---

## Family 11 — Consolidated breakage & pitfall register

| Class | Evidence |
|---|---|
| **Silent id renames/removals** | Composer vanished 0.46.2 ([forum](https://forum.cursor.com/t/cursor-composer-disappeared-in-version-0-46-2/53798)); auto-run field removed 0.48 ([forum](https://forum.cursor.com/t/how-to-automate-command-execution/69525)); rename breakage 3.0 ([forum](https://forum.cursor.com/t/after-updating-cursor-to-version-3-0-the-stability-of-sub-tasks-has-decreased-and-agents-can-no-longer-be-renamed/157149)); VS Code keybindings broke after update ([#267274](https://github.com/microsoft/vscode/issues/267274)); mode-open commands became focus-conditional dynamic registrations in 1.121 ([#318168](https://github.com/microsoft/vscode/issues/318168)); removed keybindable id ([vscode-copilot-release#1207](https://github.com/microsoft/vscode-copilot-release/issues/1207)) |
| **Focus theft** | VS Code: startup steal ([#280973](https://github.com/microsoft/vscode/issues/280973)), agent completion raise w/ `chat.focusWindowOnConfirmation` fix ([#249921](https://github.com/microsoft/vscode/issues/249921)), Visual Studio variant ([developercommunity 11088514](https://developercommunity.microsoft.com/t/11088514)); Cursor: five threads Feb–Aug 2026 incl. Windows hook-spawn without `CREATE_NO_WINDOW` v3.15.6 and Agents-Window routing needing later-added `--classic` ([157090](https://forum.cursor.com/t/agent-finish-steals-focus/157090), [167267](https://forum.cursor.com/t/agent-window-steals-focus-and-opens-file-tabs-while-typing-follow-up-promptscategory/167267), [163197](https://forum.cursor.com/t/open-cursor-with-the-editor-window-active-not-the-agent-window/163197)) |
| **Keybinding/input swallowing** | Composer input swallows user keybindings (soft-vs-hard dispatch) ([Ctrl+R thread](https://forum.cursor.com/t/ctrl-r-in-chat-composer-ignores-user-keybindings-and-still-creates-a-new-chat/156444)); chat co-opting keypresses ([vscode-copilot-release#255](https://github.com/microsoft/vscode-copilot-release/issues/255)) |
| **IME/locale** | keyCode 229 / `isComposing` ordering ([WebKit 165004](https://bugs.webkit.org/show_bug.cgi?id=165004)); macOS Electron delivers Enter before `compositionend` → truncated CJK ([hermes-desktop PR#547](https://github.com/fathah/hermes-desktop/pull/547)); macOS 26 autofill churn on IME keystrokes in Electron ([electron#52260](https://github.com/electron/electron/issues/52260) ⚠️); ibus engine switch needed before xdotool ([orca test](https://github.com/stablyai/orca/blob/main/tests/e2e/terminal-ibus-hangul-native.spec.ts)); switch-to-ABC guidance ([window-pilot](https://github.com/window-pilot/window-pilot)) |
| **OS security layers** | macOS TCC grant expiry after updates ([Apple Community](https://discussions.apple.com/thread/255165673)); CGEvent silent sandbox block ([QUICOPY](https://dev.to/quicopy/shipping-global-keyboard-shortcuts-on-macos-sandbox-the-part-apple-doesnt-document-57no)); Secure Input ([Apple forums](https://developer.apple.com/forums/thread/726353)); Windows UIPI silent SendInput failure ([MS Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)) |
| **Timing races** | Source-level: setInput vs viewModel restore; 60 s `waitForDefaultAgent` ([chatActions.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts)); `newChat` first-run no-op ([#261118](https://github.com/microsoft/vscode/issues/261118)); practitioner sleeps 300–750 ms (Family 4 sources) |
| **Trust & policy gating** | Workspace Trust disables unopted extensions; commands callable regardless → gate in code ([trust guide](https://code.visualstudio.com/api/extension-guides/workspace-trust)); chat carries `disabledInWorkspace` precondition ([chatActions.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts)) |
| **Cross-fork drift** | Theia forks omit `chat.open` (SocratiCode try/catch); Cursor ids differ (`aichat.show-ai-chat`, `composer.newAgentChat`, `cursorChat.focus`); duplicate-view-id crash class ([#212718](https://github.com/microsoft/vscode/issues/212718)) |
| **CDP operational limits** | Monaco rejects fill/type (needs paste events); native dialogs unreachable; Crashpad >2–3 instances on macOS (MS launch skill, Family 6); port-strip claim ⚠️single-source ([vscode#302362](https://github.com/microsoft/vscode/issues/302362)) |
| **Sandbox isolation** | Renderer/extension-host separation is deliberate; hostile renderer takeover demo shows why ([Knostic](https://www.knostic.ai/blog/demonstrating-code-injection-vscode-cursor)) |

---

## Master matrix — technique × IDE

| # | Technique | VS Code | Cursor | Windsurf | Void | Trae | Kiro | Zed |
|---|---|---|---|---|---|---|---|---|
| 1 | `chat.open` command | ✅ H | ⚠️ M | ❓ | ✅ M | ❓ | ❓ | ❌ |
| 2 | Participants / LM API | ✅ H (model-only) | ✅ (model-only) | ⚠️ | ✅ | ⚠️ | ⚠️ | ❌ (own ext API) |
| 3 | Command enumeration | ✅ H | ✅ H | ✅ H | ✅ H | ✅ H | ✅ H | ❌ |
| 4 | Clipboard bridge | ✅ M | ✅ M | ❓ M | ✅ M | ❓ | ❓ | ❌ |
| 5 | Webview synthetic events | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 6 | CDP attach | ✅ H* | ✅ H* | ❓ | ❓ H* | ❓ H* | ❓ H* | ⚠️ |
| 7 | OS automation | ✅ M | ✅ M | ✅ M (wsc) | ✅ M | ✅ M | ✅ M | ✅ M |
| 8 | Deep links | ✅ H (self) | ✅✅ H (vendor prompt link) | ⚠️ prefill | ✅ (self) | ❌ | ⚠️ | ⚠️ |
| 9 | Agent CLI spawn | ✅ VH | ✅ VH | ✅ VH | ✅ VH | ✅ (trae-agent) | ✅ VH | ✅ VH (ACP agents) |
| 10 | Hooks / plugins / ACP | ✅ H (per-harness) | ⚠️ hooks | ⚠️ hooks (no inject) | ❓ | ❓ | ✅ (kiro-cli acp) | ✅✅ H (native ACP) |

Legend: VH = documented contract · H = multi-source production use · M = works with known hazards · ❓ = no public evidence either way · ❌ = structurally unavailable · \* requires controlling launch flags.

## Gaps & open leads (wave-2 candidates)
- Version-diffed registry of Copilot Chat internal command ids (none published).
- Cotalker's multi-strategy send implementation (source not retrieved).
- Windsurf CDP attach evidence (none found); Windsurf deeplink grammar formalization (watch [#283](https://github.com/Exafunction/codeium/issues/283)).
- Claude Code extension's truncated `-cli://` handler mention ([docs page](https://code.claude.com/docs/en/vs-code)) — possible second scheme.
- `goose recipe deeplink <NAME>` link format & handler (unexamined).
- `.pendingSession` cross-window file-handoff as a generic task-delivery pattern ([PR #1595](https://github.com/microsoft/vscode-copilot-chat/pull/1595)).
- `chat.focusWindowOnConfirmation` / notification settings interplay with automation timing.
- did-keydown relay regression fallout post-1.124 for Plannotator-style extensions.
- ACP messaging-bridge auth models (Telegram/Discord clients listed officially).
- Kilo Code / Continue provider files (repos unindexed by code search; verify by cloning).
