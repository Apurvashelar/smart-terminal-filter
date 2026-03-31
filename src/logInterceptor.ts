/**
 * Log Interceptor — hooks into VS Code's terminal system to capture output.
 *
 * Uses two strategies:
 *  1. Shell Integration API (onDidStartTerminalShellExecution) — streams
 *     command output in real-time; fires commandStart callbacks on each new cmd.
 *  2. window.onDidWriteTerminalData (proposed API) — raw PTY fallback for
 *     terminals where shell integration is unavailable.
 *
 * Only ONE path is active per terminal per command: if the shell integration
 * stream is running, onDidWriteTerminalData is suppressed for that terminal
 * to prevent double-processing the same output.
 */

import * as vscode from 'vscode';

export interface TerminalData {
  terminalName: string;
  data: string;
  timestamp: number;
}

type DataCallback = (data: TerminalData) => void;
type CommandStartCallback = (terminalName: string) => void;

export class LogInterceptor {
  private disposables: vscode.Disposable[] = [];
  private callbacks: DataCallback[] = [];
  private commandStartCallbacks: CommandStartCallback[] = [];
  private active = true;
  private trackedTerminals: Set<string> = new Set();
  private dataBuffer: Map<string, string> = new Map();
  private flushTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingClearTerminals: Set<string> = new Set();
  private activeShellExecutions: Set<string> = new Set();

  constructor() {}

  /**
   * Start intercepting terminal output.
   */
  activate(): void {
    // Track terminal creation/closure
    this.disposables.push(
      vscode.window.onDidOpenTerminal(terminal => {
        this.trackTerminal(terminal);
      })
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal(terminal => {
        this.trackedTerminals.delete(terminal.name);
        this.dataBuffer.delete(terminal.name);
        this.pendingClearTerminals.delete(terminal.name);
        this.activeShellExecutions.delete(terminal.name);
        const timer = this.flushTimers.get(terminal.name);
        if (timer) {
          clearTimeout(timer);
          this.flushTimers.delete(terminal.name);
        }
      })
    );

    // Track existing terminals
    vscode.window.terminals.forEach(t => this.trackTerminal(t));

    // Strategy 1: Shell integration — primary data source when available.
    // Fires commandStart and streams output. Suppresses onDidWriteTerminalData
    // for the same terminal while the stream is active.
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution?.(event => {
        this.onShellExecution(event);
      }) ?? { dispose: () => {} }
    );

    // When a command ends, mark terminal for clear so the next command's first
    // data batch (via onDidWriteTerminalData fallback) triggers commandStart.
    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution?.(event => {
        if (this.active) {
          this.pendingClearTerminals.add(event.terminal.name);
        }
      }) ?? { dispose: () => {} }
    );

    // Strategy 2: Raw PTY fallback — used when shell integration is not active.
    // Skipped for terminals currently handled by the shell integration stream.
    try {
      const onWrite = (vscode.window as any).onDidWriteTerminalData;
      if (onWrite) {
        this.disposables.push(
          onWrite((event: any) => {
            if (!this.active) { return; }
            this.bufferData(event.terminal.name, event.data);
          })
        );
      }
    } catch {
      // Not available — rely on shell integration only
    }
  }

  private trackTerminal(terminal: vscode.Terminal): void {
    const name = terminal.name;
    if (this.trackedTerminals.has(name)) { return; }
    this.trackedTerminals.add(name);
  }

  private async onShellExecution(event: any): Promise<void> {
    // Cancel any pending-clear from a previous command end so flushBuffer
    // doesn't fire a second commandStart when shell integration is active.
    this.pendingClearTerminals.delete(event.terminal.name);

    // Notify listeners that a new command started
    for (const cb of this.commandStartCallbacks) {
      try { cb(event.terminal.name); } catch {}
    }

    try {
      const stream = event.execution?.read?.();
      if (!stream) { return; }

      // Mark this terminal as handled by shell integration so that
      // onDidWriteTerminalData bufferData calls are suppressed.
      this.activeShellExecutions.add(event.terminal.name);
      try {
        for await (const data of stream) {
          if (!this.active) { return; }
          this.emit({
            terminalName: event.terminal.name,
            data,
            timestamp: Date.now(),
          });
        }
      } finally {
        this.activeShellExecutions.delete(event.terminal.name);
      }
    } catch {
      this.activeShellExecutions.delete(event.terminal.name);
    }
  }

  /**
   * Buffer incoming data and flush in batches to avoid overwhelming the UI
   * with rapid small writes (terminals write character by character sometimes).
   * Skipped entirely when the shell integration stream is active for this terminal.
   */
  private bufferData(terminalName: string, data: string): void {
    // Shell integration is handling this terminal — don't double-process
    if (this.activeShellExecutions.has(terminalName)) { return; }

    const existing = this.dataBuffer.get(terminalName) || '';
    this.dataBuffer.set(terminalName, existing + data);

    // Debounce: flush after 50ms of silence
    const existingTimer = this.flushTimers.get(terminalName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.flushTimers.set(terminalName, setTimeout(() => {
      this.flushBuffer(terminalName);
    }, 50));
  }

  private flushBuffer(terminalName: string): void {
    const data = this.dataBuffer.get(terminalName);
    if (!data) { return; }
    this.dataBuffer.delete(terminalName);
    this.flushTimers.delete(terminalName);

    // Fire commandStart only when shell integration signalled a new command
    // (avoids false clears mid-build for long-running tools like Maven/Gradle).
    const pendingShellClear = this.pendingClearTerminals.has(terminalName) && data.trim().length > 3;
    if (pendingShellClear) {
      this.pendingClearTerminals.delete(terminalName);
      for (const cb of this.commandStartCallbacks) {
        try { cb(terminalName); } catch {}
      }
    }

    this.emit({
      terminalName,
      data,
      timestamp: Date.now(),
    });
  }

  private emit(data: TerminalData): void {
    for (const cb of this.callbacks) {
      try { cb(data); } catch { /* don't let a bad callback break the pipeline */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  onData(callback: DataCallback): void {
    this.callbacks.push(callback);
  }

  onCommandStart(callback: CommandStartCallback): void {
    this.commandStartCallbacks.push(callback);
  }

  pause(): void {
    this.active = false;
  }

  resume(): void {
    this.active = true;
  }

  isActive(): boolean {
    return this.active;
  }

  getTrackedTerminals(): string[] {
    return Array.from(this.trackedTerminals);
  }

  /**
   * Inject data directly into the pipeline — used by custom PTY terminals
   * (e.g. AI Smart Terminal) whose output is never seen by onDidWriteTerminalData.
   */
  injectData(terminalName: string, data: string): void {
    if (!this.active) { return; }
    this.emit({ terminalName, data, timestamp: Date.now() });
  }

  /**
   * Fire commandStart callbacks directly — used by custom PTY terminals to
   * trigger panel clear + engine reset when a new command begins executing.
   */
  injectCommandStart(terminalName: string): void {
    if (!this.active) { return; }
    for (const cb of this.commandStartCallbacks) {
      try { cb(terminalName); } catch {}
    }
  }

  dispose(): void {
    this.active = false;
    this.callbacks = [];
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.dataBuffer.clear();
    this.flushTimers.forEach(t => clearTimeout(t));
    this.flushTimers.clear();
    this.pendingClearTerminals.clear();
    this.activeShellExecutions.clear();
  }
}
