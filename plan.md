# Plan: AI Smart Terminal (Custom PTY Terminal)

**Status:** APPROVED - Ready for implementation
**Date:** 2026-03-27
**Scope:** ADD a new AI-powered terminal tab alongside all existing features. Nothing existing is removed or modified in behavior.

---

## Overview

Create a new VS Code terminal tab ("AI Smart Terminal") using a custom Pseudoterminal (PTY). When the user types in this terminal, input is intercepted. If it looks like natural language (e.g., "list all large files"), the AI translates it to a shell command, shows an inline confirmation prompt, and executes upon approval. If it looks like a regular shell command, it passes through and executes directly.

---

## 1. Files to CREATE

### 1a. `src/ai/commandGenerator.ts`

Follows the exact pattern of `src/ai/errorExplainer.ts` -- constructor takes `AIProvider`, calls `this.ai.complete()`.

**Interfaces:**
```typescript
export interface CommandContext {
  cwd: string;               // workspace root or current directory
  platform: string;          // process.platform (darwin/linux/win32)
  shell: string;             // detected shell (bash/zsh/powershell/cmd)
  recentCommands: string[];  // last 5 commands for context
}

export interface GeneratedCommand {
  command: string;           // The shell command to execute
  explanation: string;       // What it does in plain English
  confidence: 'high' | 'medium' | 'low';
  isDestructive: boolean;    // rm -rf, DROP TABLE, etc.
  durationMs: number;
  error?: string;
}
```

**Class:**
```typescript
export class CommandGenerator {
  constructor(private ai: AIProvider) {}
  async generate(naturalLanguageInput: string, context: CommandContext): Promise<GeneratedCommand>
}
```

**Implementation details:**
- System prompt instructs the AI to return a structured response:
  - Line 1: the shell command only
  - Line 2: one-sentence explanation
  - Line 3: "DESTRUCTIVE" if the command modifies/deletes data, "SAFE" otherwise
- Parse the AI response by splitting on newlines
- Temperature: 0.1 (deterministic commands)
- maxTokens: 200 (commands are short)
- If AIProvider is null or returns error, return a GeneratedCommand with `error` set

---

### 1b. `src/smartTerminal.ts`

**This is the core file.** Implements `vscode.Pseudoterminal`.

```typescript
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { CommandGenerator, GeneratedCommand, CommandContext } from './ai/commandGenerator';

export class SmartTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  private inputBuffer: string = '';
  private childProcess: ChildProcess | null = null;
  private isAwaitingConfirmation: boolean = false;
  private pendingCommand: GeneratedCommand | null = null;
  private commandHistory: string[] = [];
  private cwd: string;
  private shell: string;
  private shellFlag: string;

  constructor(
    private commandGenerator: CommandGenerator | null,
    cwd: string
  ) { /* ... */ }
}
```

**Methods to implement:**

#### `open(initialDimensions?: vscode.TerminalDimensions)`
- Print a welcome banner with ANSI colors:
  ```
  AI Smart Terminal
  Type natural language or shell commands. Prefix with ! to force shell passthrough.
  AI features: [enabled/disabled based on commandGenerator being non-null]
  ```
- Show the prompt: `ai> ` in cyan

#### `handleInput(data: string)`
Handle each character in the data string:
- Regular printable characters: append to `inputBuffer`, echo via `writeEmitter.fire(data)`
- Backspace `\x7f`: remove last char from buffer, emit `\b \b` to visually erase
- Enter `\r`: call `processInput(inputBuffer.trim())`, reset `inputBuffer = ''`
- Ctrl+C `\x03`: kill running child process if any; cancel confirmation if awaiting; clear buffer; show new prompt
- Ctrl+D `\x04`: close terminal if buffer empty
- Paste (multi-character string): iterate each char, process `\r` as line submit mid-paste
- Arrow keys / escape sequences (`\x1b[...`): ignore for MVP (do not buffer or echo)

#### `processInput(input: string)`
Decision tree (ORDER MATTERS):
1. If `isAwaitingConfirmation` is true:
   - `y` or `yes` -> execute `pendingCommand.command`, clear confirmation state
   - `n` or `no` -> cancel, clear confirmation state, show new prompt
   - `e` or `edit` -> write command text into buffer for user to edit (stretch goal, can show prompt pre-filled)
   - Anything else -> print "Type y/n/e" and re-show confirmation prompt
2. Empty input -> show new prompt, return
3. Starts with `!` -> strip `!`, execute remainder as shell command directly
4. Starts with `?` -> show help text
5. Call `classifyInput(input)`:
   - Returns `'shell'` -> execute directly via `executeCommand(input)`
   - Returns `'natural_language'` -> if no `commandGenerator`, print "AI not configured" message and show prompt; otherwise call `commandGenerator.generate()`, then `showConfirmation(result)`

#### `classifyInput(input: string): 'shell' | 'natural_language'`
Local heuristic, NO AI call:
- **Shell command** if ANY of:
  - First token (split by space) is in known commands list: `ls, cd, pwd, mkdir, rmdir, rm, cp, mv, cat, grep, find, git, npm, npx, yarn, pnpm, node, python, python3, pip, pip3, docker, kubectl, curl, wget, chmod, chown, sudo, echo, export, source, make, cargo, go, dotnet, java, javac, gcc, g++, clang, brew, apt, yum, dnf, pacman, ssh, scp, rsync, tar, zip, unzip, ps, kill, top, htop, man, which, where, whoami, env, set, unset, alias, touch, head, tail, wc, sort, uniq, sed, awk, xargs, tee, diff, patch, vi, vim, nano, code, open, start, clear, history, date, cal, df, du, free, uname, hostname, ping, traceroute, nslookup, dig, nc, telnet, terraform, aws, gcloud, az, helm, ansible, vagrant`
  - Contains pipe `|`, redirect `>` / `>>` / `<`, or background `&`
  - Starts with `./` or `/` (path execution)
  - Matches variable assignment: `^[A-Z_]+=`
  - Single word with no spaces and length > 1 (likely a binary name)
- **Natural language** otherwise

#### `executeCommand(command: string)`
- If `childProcess` is already running, print warning and return
- Display: `\x1b[90m$ command\x1b[0m\r\n` (gray, showing what's being run)
- Spawn: `spawn(this.shell, [this.shellFlag, command], { cwd: this.cwd, env: process.env })`
- Pipe `stdout` and `stderr` to `writeEmitter.fire()` -- MUST replace `\n` with `\r\n`
- On process `close` event: store command in `commandHistory` (keep last 10), set `childProcess = null`, show new prompt
- On process `error` event: print error message in red, show new prompt

#### `showConfirmation(generated: GeneratedCommand)`
If `generated.error` is set, print the error in red and show new prompt. Otherwise display:
```
Suggested command:
  $ <command in bold green>
  <explanation in dim/gray>
  [Warning: This command modifies/deletes data]  <-- only if isDestructive
Run? [y]es / [n]o / [e]dit
```
Set `isAwaitingConfirmation = true` and `pendingCommand = generated`.

#### `showPrompt()`
```typescript
this.writeEmitter.fire('\r\n\x1b[36mai>\x1b[0m ');
```

#### `close()`
- Kill child process if running
- Dispose emitters

#### Platform detection (in constructor):
```typescript
this.shell = process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');
this.shellFlag = process.platform === 'win32' ? '/c' : '-c';
```

---

## 2. Files to MODIFY

### 2a. `src/ai/index.ts`

Add one line:
```typescript
export { CommandGenerator, GeneratedCommand, CommandContext } from './commandGenerator';
```

### 2b. `src/extension.ts`

**Add imports** (after existing imports, around line 17):
```typescript
import { CommandGenerator } from './ai/commandGenerator';
import { SmartTerminal } from './smartTerminal';
```

**Add module-level variables** (after `nlQuery` on line 26):
```typescript
let commandGenerator: CommandGenerator | null = null;
```

**Modify `initializeAI()` function** (around line 226):
- In the success branch (after `nlQuery = new NaturalLanguageQuery(aiProvider);` on line 239), add:
  ```typescript
  commandGenerator = new CommandGenerator(aiProvider);
  ```
- In the no-API-key branch (after `nlQuery = new NaturalLanguageQuery();` on line 233), add:
  ```typescript
  commandGenerator = null;
  ```

**Add new command registration** inside the `context.subscriptions.push(...)` block (after the `smartTerminal.clearApiKey` command around line 135):
```typescript
vscode.commands.registerCommand('smartTerminal.openAITerminal', () => {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || process.env.USERPROFILE || '';
  const smartTerm = new SmartTerminal(commandGenerator, wsRoot);
  const terminal = vscode.window.createTerminal({
    name: 'AI Smart Terminal',
    pty: smartTerm,
    iconPath: new vscode.ThemeIcon('sparkle'),
  });
  terminal.show();
}),
```

Note: We do NOT need to store `smartTerminalInstance` at module level -- VS Code manages the terminal lifecycle. Each invocation creates a fresh instance. The terminal's `close()` method handles cleanup.

### 2c. `package.json`

**Add command** to `contributes.commands` array:
```json
{
  "command": "smartTerminal.openAITerminal",
  "title": "Smart Terminal: Open AI Terminal",
  "icon": "$(sparkle)"
}
```

**Add keybinding** to `contributes.keybindings` array:
```json
{
  "command": "smartTerminal.openAITerminal",
  "key": "ctrl+shift+i",
  "mac": "cmd+shift+i"
}
```

**Add configuration properties** to `contributes.configuration.properties`:
```json
"smartTerminal.aiTerminal.confirmBeforeExecute": {
  "type": "boolean",
  "default": true,
  "description": "Always show confirmation before executing AI-generated commands"
},
"smartTerminal.aiTerminal.showExplanation": {
  "type": "boolean",
  "default": true,
  "description": "Show plain-English explanation of generated commands"
}
```

---

## 3. Step-by-Step Implementation Order

```
Step 1: Create src/ai/commandGenerator.ts
        - CommandGenerator class, GeneratedCommand interface, CommandContext interface
        - System prompt, response parsing, error handling
        - Run: npx tsc --noEmit

Step 2: Update src/ai/index.ts
        - Add export line for CommandGenerator
        - Run: npx tsc --noEmit

Step 3: Create src/smartTerminal.ts
        - SmartTerminal class implementing vscode.Pseudoterminal
        - open() with welcome banner
        - handleInput() with character buffering, backspace, Enter, Ctrl+C, Ctrl+D, paste
        - classifyInput() with known-commands heuristic
        - executeCommand() with child_process.spawn
        - showConfirmation() with ANSI-colored inline display
        - processInput() state machine (confirmation check FIRST, then classify)
        - showPrompt(), close()
        - Run: npx tsc --noEmit

Step 4: Modify src/extension.ts
        - Add imports
        - Add commandGenerator variable
        - Update initializeAI() to create/nullify commandGenerator
        - Register smartTerminal.openAITerminal command
        - Run: npx tsc --noEmit

Step 5: Modify package.json
        - Add command, keybinding, configuration properties
        - Run: npm run build
        - Run: npm run package (verify .vsix builds)

Step 6: Manual testing in Extension Development Host (F5)
        - Open AI Terminal via command palette or Cmd+Shift+I
        - Type a shell command (e.g., "ls -la") -> executes directly
        - Type natural language (e.g., "show me all js files") -> AI suggestion + confirmation
        - Press y -> executes
        - Press n -> cancels
        - Ctrl+C during running command -> kills it
        - ! prefix -> forced shell passthrough
        - Verify ALL existing features still work (log panel, error explain, summarize, query)
```

---

## 4. Key Code Patterns / Interfaces

### Pseudoterminal API (the only hooks VS Code gives us):
```typescript
interface Pseudoterminal {
  onDidWrite: Event<string>;           // Fire to display text in terminal
  onDidClose?: Event<number | void>;   // Fire to close terminal
  open(initialDimensions?: TerminalDimensions): void;
  close(): void;
  handleInput?(data: string): void;    // Called when user types
}
```

### Child process execution:
```typescript
const proc = spawn(this.shell, [this.shellFlag, command], {
  cwd: this.cwd,
  env: { ...process.env },
});
proc.stdout?.on('data', (data: Buffer) => {
  this.writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
});
proc.stderr?.on('data', (data: Buffer) => {
  this.writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
});
proc.on('close', (code) => {
  this.childProcess = null;
  this.showPrompt();
});
```

### ANSI color codes:
```
Reset:   \x1b[0m     Bold:    \x1b[1m     Dim:     \x1b[2m
Red:     \x1b[31m    Green:   \x1b[32m    Yellow:  \x1b[33m
Cyan:    \x1b[36m    Gray:    \x1b[90m
```

### AI call pattern (matches existing codebase):
```typescript
const resp = await this.ai.complete({
  systemPrompt: SYSTEM_PROMPT,
  userPrompt: userPrompt,
  maxTokens: 200,
  temperature: 0.1,
});
if (resp.error) { return { ..., error: resp.error }; }
// parse resp.content
```

---

## 5. Gotchas the Developer MUST Know

### G1: Terminal newlines are `\r\n`, not `\n`
The Pseudoterminal `onDidWrite` expects `\r\n`. If you fire just `\n`, the cursor moves down but NOT to column 0, producing staircase text. Every string written via `writeEmitter.fire()` must use `\r\n`. Child process output must have `\n` replaced with `\r\n`.

### G2: handleInput receives raw bytes, not cooked lines
- Regular characters: their literal value
- Enter: `\r` (NOT `\n`)
- Backspace: `\x7f` (NOT `\b`)
- Ctrl+C: `\x03`
- Ctrl+D: `\x04`
- Arrow keys: escape sequences `\x1b[A` (up), `\x1b[B` (down), `\x1b[C` (right), `\x1b[D` (left)
- Paste: multiple characters arrive in a single call

### G3: Echo is manual
The PTY does NOT auto-echo. You must explicitly `writeEmitter.fire(char)` for each typed character to show it. This gives full control but means forgetting to echo = invisible typing.

### G4: Confirmation state must be checked FIRST
In `processInput()`, check `isAwaitingConfirmation` BEFORE `classifyInput()`. Otherwise typing `y` gets classified as a shell command and executed literally as the `y` binary (which exists on some systems).

### G5: No AI configured = graceful shell passthrough
When `commandGenerator` is null (no API key set), the terminal must still function as a basic shell. Print a one-time notice on `open()`: "AI features disabled. Run 'Smart Terminal: Set AI API Key' to enable." Then classify everything as shell and execute directly.

### G6: Existing features are NOT touched
Do NOT modify `webviewPanel.ts`, `filterEngine.ts`, `logInterceptor.ts`, `statusBar.ts`, `logClassifier.ts`, or `stackTraceGrouper.ts`. The only modified files are `extension.ts`, `ai/index.ts`, and `package.json`.

### G7: Platform-aware shell detection
```typescript
const shell = process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');
const shellFlag = process.platform === 'win32' ? '/c' : '-c';
```

### G8: Kill running process before new command
Always check `if (this.childProcess)` before spawning. If a process is running, either reject the new command or kill the existing one first.

### G9: Pasted multi-line input
`handleInput` can receive an entire pasted block. Iterate character by character. When `\r` is encountered, process the buffer as a submitted line, then continue buffering the rest.

### G10: LogInterceptor will capture AI Terminal output
The existing `onDidWriteTerminalData` fires for ALL terminals, including custom PTYs. This means the AI Smart Terminal's output will appear in the filtered log panel too. This is expected behavior and requires no special handling.

---

## Verification

```bash
npx tsc --noEmit   # must pass with 0 errors
npm run build      # must pass cleanly
npm run package    # must produce .vsix
```

**Manual test checklist:**
- [ ] `Cmd+Shift+I` opens a new terminal tab named "AI Smart Terminal"
- [ ] Welcome banner displays on open
- [ ] `ls -la` executes directly (classified as shell)
- [ ] `git status` executes directly (classified as shell)
- [ ] `show me all javascript files` triggers AI -> shows confirmation
- [ ] Pressing `y` executes the suggested command
- [ ] Pressing `n` cancels and returns to prompt
- [ ] `!some weird thing` executes as shell directly (passthrough)
- [ ] `?` shows help text
- [ ] Ctrl+C kills a running command
- [ ] Ctrl+C during confirmation cancels it
- [ ] Backspace works correctly (erases character)
- [ ] No API key configured -> terminal works as basic shell with notice
- [ ] Existing features unaffected: log filtering, error explanation, summarize, query, verbosity, capture toggle
