/**
 * Status Bar — command status icon, error counts, verbosity, capture toggle.
 * Feature 3: Flashes on new errors + debounced toast notifications.
 */

import * as vscode from 'vscode';
import { FilterStats, CommandStatus, VerbosityLevel } from './filterEngine';

const VERBOSITY_LABELS: Record<number, string> = {
  1: '$(filter) L1: Errors only',
  2: '$(filter) L2: +Warnings',
  3: '$(filter) L3: +Status',
  4: '$(filter) L4: +Verbose',
  5: '$(filter) L5: Raw',
};

const STATUS_ICONS: Record<CommandStatus, string> = {
  success: '$(check)', error: '$(error)', warning: '$(warning)',
  running: '$(sync~spin)', idle: '$(circle-outline)',
};

export class StatusBarController {
  private statusItem: vscode.StatusBarItem;
  private verbosityItem: vscode.StatusBarItem;
  private statsItem: vscode.StatusBarItem;
  private captureItem: vscode.StatusBarItem;
  private capturing = true;

  // Toast debounce state
  private lastToastTime = 0;
  private toastDebounceMs = 5000;
  private hasShownOutputToast = false;
  private previousErrorCount = 0;

  // Flash state
  private flashTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    this.statusItem.command = 'smartTerminal.openPanel';
    this.statusItem.tooltip = 'Smart Terminal \u2014 click to open filtered panel';
    this.statusItem.text = `${STATUS_ICONS.idle} Smart Terminal`;
    this.statusItem.show();

    this.verbosityItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.verbosityItem.command = 'smartTerminal.setVerbosity';
    this.verbosityItem.tooltip = 'Click to change verbosity level';
    this.verbosityItem.show();

    this.statsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statsItem.command = 'smartTerminal.openPanel';
    this.statsItem.tooltip = 'Click to open Smart Terminal panel';
    this.statsItem.show();

    this.captureItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.captureItem.command = 'smartTerminal.toggleCapture';
    this.captureItem.tooltip = 'Toggle log capture';
    this.captureItem.show();

    this.updateVerbosity(2);
    this.updateCapture(true);
  }

  updateVerbosity(level: VerbosityLevel): void {
    this.verbosityItem.text = VERBOSITY_LABELS[level] || `$(filter) L${level}`;
  }

  updateStats(stats: FilterStats): void {
    // --- Stats badges ---
    const parts: string[] = [];
    if (stats.errors > 0) parts.push(`$(error) ${stats.errors}`);
    if (stats.warnings > 0) parts.push(`$(warning) ${stats.warnings}`);
    parts.push(`$(output) ${stats.visibleLines}/${stats.totalLines}`);
    if (stats.noiseHidden > 0) parts.push(`$(eye-closed) ${stats.noiseHidden} hidden`);
    this.statsItem.text = parts.join('  ');

    // --- Stats background ---
    if (stats.errors > 0) {
      this.statsItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.statsItem.color = undefined;
    } else if (stats.warnings > 0) {
      this.statsItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statsItem.color = undefined;
    } else if (stats.totalLines > 0) {
      this.statsItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
      this.statsItem.color = new vscode.ThemeColor('terminal.ansiGreen');
    } else {
      this.statsItem.backgroundColor = undefined;
      this.statsItem.color = undefined;
    }

    // --- Command status icon ---
    const status = stats.commandStatus || 'idle';
    this.statusItem.text = `${STATUS_ICONS[status]} Smart Terminal`;
    this.statusItem.tooltip = stats.commandStatusMessage || 'Smart Terminal';

    if (status === 'error') {
      this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.statusItem.color = undefined;
    } else if (status === 'warning') {
      this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusItem.color = undefined;
    } else if (status === 'success') {
      this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
      this.statusItem.color = new vscode.ThemeColor('terminal.ansiGreen');
    } else {
      this.statusItem.backgroundColor = undefined;
      this.statusItem.color = undefined;
    }

    // --- Feature 3: Flash + Toast on new errors ---
    const now = Date.now();
    const hasNewErrors = stats.errors > this.previousErrorCount;

    if (hasNewErrors && stats.totalLines > 0) {
      // Flash status bar
      this.flashStatusBar();

      // Debounced toast — max one per 5 seconds
      if (now - this.lastToastTime > this.toastDebounceMs) {
        this.lastToastTime = now;
        const newCount = stats.errors - this.previousErrorCount;
        this.showToast(
          `Smart Terminal: ${newCount === 1 ? 'Error' : newCount + ' errors'} detected in terminal output`,
          true
        );
      }
    } else if (!this.hasShownOutputToast && stats.totalLines > 0 && stats.errors === 0) {
      // First output without errors — show a gentle notification once
      if (now - this.lastToastTime > this.toastDebounceMs) {
        this.hasShownOutputToast = true;
        this.lastToastTime = now;
        this.showToast('Smart Terminal: New output detected', false);
      }
    }

    this.previousErrorCount = stats.errors;
  }

  /**
   * Flash the status bar red 3 times over ~2 seconds.
   */
  private flashStatusBar(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    let count = 0;
    const errorBg = new vscode.ThemeColor('statusBarItem.errorBackground');
    const flash = () => {
      count++;
      if (count > 6) {
        this.statusItem.backgroundColor = errorBg;
        this.flashTimer = null;
        return;
      }
      this.statusItem.backgroundColor = (count % 2 === 0) ? errorBg : undefined;
      this.statsItem.backgroundColor = (count % 2 === 0) ? errorBg : undefined;
      this.flashTimer = setTimeout(flash, 350);
    };
    flash();
  }

  /**
   * Show a toast notification with "Open Smart Terminal" action.
   */
  private showToast(message: string, isError: boolean): void {
    const showFn = isError ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
    showFn(message, 'Open Smart Terminal').then(action => {
      if (action === 'Open Smart Terminal') {
        vscode.commands.executeCommand('smartTerminal.openPanel');
      }
    });
  }

  updateCapture(active: boolean): void {
    this.capturing = active;
    this.captureItem.text = active ? '$(debug-start) Capturing' : '$(debug-pause) Paused';
    this.captureItem.backgroundColor = active ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  isCapturing(): boolean { return this.capturing; }

  resetErrorTracking(): void {
    this.previousErrorCount = 0;
    this.hasShownOutputToast = false;
    this.statusItem.text = `${STATUS_ICONS.idle} Smart Terminal`;
    this.statusItem.backgroundColor = undefined;
    this.statusItem.color = undefined;
    this.statsItem.backgroundColor = undefined;
    this.statsItem.color = undefined;
  }

  dispose(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.statusItem.dispose();
    this.verbosityItem.dispose();
    this.statsItem.dispose();
    this.captureItem.dispose();
  }
}
