/**
 * Log Interceptor — hooks into VS Code's terminal system to capture output.
 * 
 * Uses two strategies:
 *  1. window.onDidWriteTerminalData (proposed API) — captures raw PTY output
 *  2. Shell Integration API — captures command-level output with exit codes
 *  
 * Falls back gracefully if APIs aren't available.
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
  private lastDataTime: Map<string, number> = new Map();
  private readonly activityGapMs = 1500; // gap that signals a new command

  constructor() {}

  /**
   * Start intercepting terminal output.
   */
  activate(): void {
    // Strategy 1: Track terminal creation/closure
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
        this.lastDataTime.delete(terminal.name);
        const timer = this.flushTimers.get(terminal.name);
        if (timer) {
          clearTimeout(timer);
          this.flushTimers.delete(terminal.name);
        }
      })
    );

    // Track existing terminals
    vscode.window.terminals.forEach(t => this.trackTerminal(t));

    // Strategy 2: Shell integration for command-level tracking
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution?.(event => {
        this.onShellExecution(event);
      }) ?? { dispose: () => {} }
    );

    // Fallback: when a command ends, mark terminal as needing a clear so the
    // next incoming data batch triggers commandStartCallbacks (covers terminals
    // where onDidStartTerminalShellExecution doesn't fire reliably).
    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution?.(event => {
        if (this.active) {
          this.pendingClearTerminals.add(event.terminal.name);
        }
      }) ?? { dispose: () => {} }
    );

    // Strategy 3: Use onDidWriteTerminalData if available
    // This is a proposed API — may not be available in stable VS Code.
    // We use it when available for real-time streaming.
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
      // Not available — we'll rely on shell integration
    }
  }

  private trackTerminal(terminal: vscode.Terminal): void {
    const name = terminal.name;
    if (this.trackedTerminals.has(name)) { return; }
    this.trackedTerminals.add(name);

    // If shell integration is available, listen for command completions
    if (terminal.shellIntegration) {
      this.attachShellIntegration(terminal);
    }

    // Also listen for shell integration activation
    const disposable = vscode.window.onDidChangeTerminalShellIntegration?.(event => {
      if (event.terminal === terminal) {
        this.attachShellIntegration(terminal);
      }
    });

    if (disposable) {
      this.disposables.push(disposable);
    }
  }

  private attachShellIntegration(terminal: vscode.Terminal): void {
    const si = terminal.shellIntegration;
    if (!si) { return; }

    // Listen for command executions
    try {
      this.disposables.push(
        vscode.window.onDidEndTerminalShellExecution?.(event => {
          if (!this.active) { return; }
          if (event.terminal === terminal) {
            // Read the command output via the shell integration stream
            this.readShellExecution(event);
          }
        }) ?? { dispose: () => {} }
      );
    } catch {
      // Shell integration events not available
    }
  }

  private async readShellExecution(event: any): Promise<void> {
    try {
      const execution = event.execution;
      if (!execution) { return; }

      // The shellExecution has a read() stream
      const stream = execution.read?.();
      if (!stream) { return; }

      let fullOutput = '';
      for await (const data of stream) {
        fullOutput += data;
      }

      if (fullOutput) {
        this.emit({
          terminalName: event.terminal.name,
          data: fullOutput,
          timestamp: Date.now(),
        });
      }
    } catch {
      // Stream reading failed
    }
  }

  private async onShellExecution(event: any): Promise<void> {
    // onDidStartTerminalShellExecution fired — cancel the pending-clear fallback
    // so flushBuffer doesn't double-clear when shell integration is fully active.
    this.pendingClearTerminals.delete(event.terminal.name);
    // Notify listeners that a new command started
    for (const cb of this.commandStartCallbacks) {
      try { cb(event.terminal.name); } catch {}
    }
    // Track active executions
    try {
      const stream = event.execution?.read?.();
      if (!stream) { return; }

      for await (const data of stream) {
        if (!this.active) { return; }
        this.emit({
          terminalName: event.terminal.name,
          data,
          timestamp: Date.now(),
        });
      }
    } catch {
      // Not available
    }
  }

  /**
   * Buffer incoming data and flush in batches to avoid overwhelming the UI
   * with rapid small writes (terminals write character by character sometimes).
   */
  private bufferData(terminalName: string, data: string): void {
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

    const now = Date.now();
    const last = this.lastDataTime.get(terminalName) ?? 0;
    const gap = now - last;

    // Fire commandStart if shell integration signalled it OR if there has been
    // a long enough pause since the last output (covers terminals without
    // shell integration — any gap ≥ activityGapMs means a new command ran).
    const pendingShellClear = this.pendingClearTerminals.has(terminalName) && data.trim().length > 3;
    const gapClear = last > 0 && gap >= this.activityGapMs;

    if (pendingShellClear || gapClear) {
      this.pendingClearTerminals.delete(terminalName);
      for (const cb of this.commandStartCallbacks) {
        try { cb(terminalName); } catch {}
      }
    }

    this.lastDataTime.set(terminalName, now);
    this.emit({
      terminalName,
      data,
      timestamp: now,
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

  dispose(): void {
    this.active = false;
    this.callbacks = [];
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.dataBuffer.clear();
    this.flushTimers.forEach(t => clearTimeout(t));
    this.flushTimers.clear();
    this.pendingClearTerminals.clear();
    this.lastDataTime.clear();
  }
}
