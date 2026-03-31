# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run build          # clean + compile extension + compile CLI (full build)
npm run compile        # compile extension only (src/ → out/)
npm run watch          # incremental compile on save
npm run package        # produce .vsix for manual install
```

No test runner is configured. There is no linter (no ESLint). TypeScript strict mode is on — `npx tsc --noEmit` is the fastest way to type-check without emitting files.

**To test the extension locally:** Press **F5** in VS Code to launch an Extension Development Host. Alternatively: `npm run build && npm run package`, then `Cmd+Shift+P → Extensions: Install from VSIX`.

**Two build targets:**
- `tsconfig.json` → compiles `src/` to `out/` (the VS Code extension, `main: ./out/extension.js`)
- `tsconfig.cli.json` → compiles `cli/` to `out-cli/` (the `smartlog` CLI binary)

## Architecture

### Data Pipeline (extension mode)

Every terminal line travels through this exact chain:

```
VS Code terminal PTY
  → LogInterceptor          (two strategies: shell integration stream + onDidWriteTerminalData fallback)
  → FilterEngine.processData()
      → LogClassifier.classify()     assigns LogLevel, LogCategory, noiseScore, source, isAnsiRed, isUserCodeFrame
      → StackTraceGrouper.processLine()  groups multi-line stack traces into collapsible StackTraceGroup objects
      → FilterEngine.shouldShow()    decides visibility based on verbosity + dedup rules
  → FilteredEntry { line, visible, stackGroup, isStackGroupHeader, errorCount }
  → WebviewPanel.sendEntry()         posts JSON message to the webview iframe
  → StatusBar.updateStats()          updates status bar item + toast notifications
```

`FilterEngine` owns all state: the entry buffer (up to 5000 lines), error dedup maps (`errorCounts`, `errorFirstEntry`, `suppressedGroupIds`, `suppressedLineNumbers`), and the `stats` object. It fires callbacks (`onStatsChange`, `onRetroactiveHide`, `onRetroactiveHideEntry`) that `extension.ts` wires to the panel and status bar.

### Webview Communication Pattern

The panel (`src/webviewPanel.ts`) is a VS Code WebviewView. All communication is message-passing:

- **Extension → webview:** `panel.sendXxx()` calls `this.post({type, ...})` → `webview.postMessage()`
- **Webview → extension:** `V.postMessage({type, ...})` in the webview JS → `panel.onMessage(type, handler)` registered in `extension.ts`

If the view is hidden (but context is retained via `retainContextWhenHidden: true`), messages queue in `pendingMessages[]` and flush when the view resolves. `bulkEntries` is a full reset-and-replace — it clears the DOM before re-adding, so it is safe to call on an already-populated panel.

### Classification Rules

`LogClassifier` checks patterns in this priority order:
1. Custom signal patterns → `USER` level (always shown)
2. `BUILD_TOOL_BOILERPLATE_PATTERNS` → downgrade to `UNKNOWN` before ERROR patterns fire (prevents Maven `[ERROR] -> [Help 1]` from counting as an error)
3. `ERROR_PATTERNS` / `STACK_TRACE_PATTERNS` → `ERROR`
4. `WARN_PATTERNS` → `WARN`
5. User console → `USER`, status → `STATUS`, etc.

`noiseScore` 0–100: errors/user logs score 0, framework banners score 85–95. `shouldShow()` gates on verbosity level and always shows `isAnsiRed` lines (unless UNKNOWN + noiseScore ≥ 85 — boilerplate can override color).

`isUserCodeFrame` on stack trace lines: a frame is user-code if its extracted `source` is not in `node_modules`, `node:internal`, `site-packages`, Java stdlib, etc. — OR if it's a diagnostic detail line (symbol:, location:, Caused by:) with no source. `shouldShow()` only shows stack trace lines where `isUserCodeFrame` is true.

### Duplicate Error Suppression

`FilterEngine` tracks each unique ERROR line (first 120 chars of cleaned text) in `errorCounts`. On the 2nd occurrence of the same error that starts a new stack group, the first group is retroactively hidden (`sendHideStackGroup` / `sendHideEntry`) and the second is shown with an "↻ Nth time" badge. `suppressedGroupIds` and `suppressedLineNumbers` survive verbosity changes because `recalcStats()` re-applies them after `shouldShow()`.

### AI Layer

All AI features are optional and gracefully degrade. The pattern to add a new AI feature:
1. Create `src/ai/myFeature.ts` with a class that takes `AIProvider` in the constructor and calls `this.ai.complete({ systemPrompt, userPrompt, maxTokens, temperature })`
2. Export from `src/ai/index.ts`
3. Instantiate in `extension.ts` alongside `errorExplainer`, wire a command + `panel.onMessage` handler
4. Add `panel.sendMyResult(result)` + `sendMyResult` method in `webviewPanel.ts`
5. Handle the result message in the webview JS switch statement

`AIProvider` supports Claude (default: `claude-sonnet-4-20250514`), OpenAI (`gpt-4o-mini`), and Ollama (local). API keys are stored in the OS keychain via `context.secrets` — never in settings files.

### Release

```bash
npm run build          # must pass with no errors
npm run package        # produces .vsix
vsce publish patch     # publish + auto-bump patch version
```

Bump `package.json` version manually for minor/major. The CLI (`smartlog`) shares `LogClassifier` and `FilterEngine` with the extension — changes to those files affect both.
