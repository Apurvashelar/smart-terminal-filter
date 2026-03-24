/**
 * Filter Engine — the orchestrator.
 *
 * Combines classifier, stack trace grouper, and framework detector.
 * Auto-computes command-level success/error status (Feature 1).
 */

import { ClassifiedLine, LogClassifier, LogLevel, LogCategory } from './logClassifier';
import { StackTraceGrouper, StackTraceGroup } from './stackTraceGrouper';
import { FrameworkDetector, FrameworkProfile } from './frameworkDetector';

export type VerbosityLevel = 1 | 2 | 3 | 4 | 5;

export interface FilteredEntry {
  line: ClassifiedLine;
  visible: boolean;
  stackGroup?: StackTraceGroup;
  isStackGroupHeader: boolean;
  errorCount?: number;
}

export type CommandStatus = 'success' | 'error' | 'warning' | 'running' | 'idle';

export interface FilterStats {
  totalLines: number;
  visibleLines: number;
  errors: number;
  warnings: number;
  userLogs: number;
  noiseHidden: number;
  stackTraceGroups: number;
  commandStatus: CommandStatus;
  commandStatusMessage: string;
}

export class FilterEngine {
  private classifier: LogClassifier;
  private grouper: StackTraceGrouper;
  private frameworkDetector: FrameworkDetector;
  private entries: FilteredEntry[] = [];
  private maxLines: number;
  private verbosity: VerbosityLevel = 2;
  private detectedFrameworks: FrameworkProfile[] = [];
  private runtimeDetectedFramework: FrameworkProfile | null = null;
  private stats: FilterStats = this.emptyStats();
  private onEntryCallbacks: Array<(entry: FilteredEntry) => void> = [];
  private onStatsChangeCallbacks: Array<(stats: FilterStats) => void> = [];
  private errorCounts: Map<string, number> = new Map();

  constructor(maxLines: number = 5000) {
    this.classifier = new LogClassifier();
    this.grouper = new StackTraceGrouper();
    this.frameworkDetector = new FrameworkDetector();
    this.maxLines = maxLines;
  }

  setVerbosity(level: VerbosityLevel): void {
    this.verbosity = level;
    this.entries.forEach(entry => { entry.visible = this.shouldShow(entry.line); });
    this.recalcStats();
  }

  getVerbosity(): VerbosityLevel { return this.verbosity; }

  setCustomPatterns(noise: string[], signal: string[]): void {
    this.classifier.setCustomPatterns(noise, signal);
  }

  detectFrameworks(workspaceRoot: string): string[] {
    this.detectedFrameworks = this.frameworkDetector.detect(workspaceRoot);
    return this.detectedFrameworks.map(f => f.displayName);
  }

  processData(data: string, terminalName: string): FilteredEntry[] {
    const lines = data.split(/\r?\n/);
    const newEntries: FilteredEntry[] = [];

    for (const rawLine of lines) {
      if (rawLine === '') continue;
      if (!this.runtimeDetectedFramework) {
        this.runtimeDetectedFramework = this.frameworkDetector.detectFromOutput(rawLine);
      }
      const classified = this.classifier.classify(rawLine, terminalName);
      const { group, isNewGroup } = this.grouper.processLine(classified);
      const visible = this.shouldShow(classified);
      const entry: FilteredEntry = {
        line: classified, visible,
        stackGroup: group || undefined,
        isStackGroupHeader: isNewGroup,
      };
      if (classified.level === LogLevel.ERROR) {
        const key = classified.cleaned.substring(0, 120);
        const count = (this.errorCounts.get(key) || 0) + 1;
        this.errorCounts.set(key, count);
        entry.errorCount = count;
      }
      this.entries.push(entry);
      newEntries.push(entry);
      this.updateStats(classified, visible);
      this.onEntryCallbacks.forEach(cb => cb(entry));
    }

    if (this.entries.length > this.maxLines) {
      this.entries.splice(0, this.entries.length - this.maxLines);
    }
    this.onStatsChangeCallbacks.forEach(cb => cb(this.stats));
    return newEntries;
  }

  private shouldShow(line: ClassifiedLine): boolean {
    if (this.verbosity >= 5) return true;
    if (line.level === LogLevel.ERROR || line.level === LogLevel.USER) return true;
    if (line.isStackTraceLine) return true;

    const thresholds: Record<VerbosityLevel, number> = { 1: 10, 2: 20, 3: 30, 4: 70, 5: 100 };
    const threshold = thresholds[this.verbosity] ?? 50;

    const lvl = line.level as string;
    switch (this.verbosity) {
      case 1: return lvl === LogLevel.ERROR || lvl === LogLevel.USER;
      case 2:
        if (lvl === LogLevel.WARN) return true;
        return lvl === LogLevel.ERROR || lvl === LogLevel.USER;
      case 3:
        if (lvl === LogLevel.WARN || lvl === LogLevel.STATUS) return true;
        if (line.category === LogCategory.BUILD_OUTPUT) return true;
        return lvl === LogLevel.ERROR || lvl === LogLevel.USER;
      case 4:
        if (lvl === LogLevel.UNKNOWN && line.noiseScore < threshold) return true;
        return lvl !== LogLevel.TRACE && line.noiseScore < threshold;
    }
    return line.noiseScore <= threshold;
  }

  // ---------------------------------------------------------------------------
  // Stats with Command Status (Feature 1)
  // ---------------------------------------------------------------------------

  private emptyStats(): FilterStats {
    return {
      totalLines: 0, visibleLines: 0, errors: 0, warnings: 0,
      userLogs: 0, noiseHidden: 0, stackTraceGroups: 0,
      commandStatus: 'idle',
      commandStatusMessage: 'Waiting for terminal output...',
    };
  }

  private updateStats(line: ClassifiedLine, visible: boolean): void {
    this.stats.totalLines++;
    if (visible) this.stats.visibleLines++; else this.stats.noiseHidden++;
    if (line.level === LogLevel.ERROR) this.stats.errors++;
    if (line.level === LogLevel.WARN) this.stats.warnings++;
    if (line.level === LogLevel.USER) this.stats.userLogs++;
    if (line.isFirstOfGroup) this.stats.stackTraceGroups++;
    this.stats.commandStatus = this.computeCommandStatus();
    this.stats.commandStatusMessage = this.computeStatusMessage();
  }

  private computeCommandStatus(): CommandStatus {
    if (this.stats.totalLines === 0) return 'idle';
    if (this.stats.errors > 0) return 'error';
    if (this.stats.warnings > 0) return 'warning';
    const hasSuccess = this.entries.some(e =>
      e.line.level === LogLevel.STATUS &&
      /\b(success|succeed|ready|started|compiled|listening|running|complete|done)\b/i.test(e.line.cleaned)
    );
    return hasSuccess ? 'success' : 'running';
  }

  private computeStatusMessage(): string {
    const s = this.stats;
    if (s.totalLines === 0) return 'Waiting for terminal output...';
    if (s.errors > 0) {
      const e = s.errors === 1 ? '1 error' : `${s.errors} errors`;
      const w = s.warnings > 0 ? `, ${s.warnings} warning${s.warnings > 1 ? 's' : ''}` : '';
      return `Failed \u2014 ${e}${w} detected. Not completed successfully.`;
    }
    if (s.warnings > 0) {
      return `Completed with ${s.warnings} warning${s.warnings > 1 ? 's' : ''} \u2014 review recommended.`;
    }
    const hasSuccess = this.entries.some(e =>
      e.line.level === LogLevel.STATUS &&
      /\b(success|succeed|ready|started|compiled|listening|running|complete|done)\b/i.test(e.line.cleaned)
    );
    if (hasSuccess) return 'Completed successfully \u2014 no errors detected.';
    return `Running \u2014 ${s.totalLines} lines processed, no errors so far.`;
  }

  private recalcStats(): void {
    this.stats = this.emptyStats();
    for (const entry of this.entries) {
      entry.visible = this.shouldShow(entry.line);
      this.updateStats(entry.line, entry.visible);
    }
  }

  getStats(): FilterStats { return { ...this.stats }; }
  getVisibleEntries(): FilteredEntry[] { return this.entries.filter(e => e.visible); }
  getAllEntries(): FilteredEntry[] { return [...this.entries]; }
  getErrors(): FilteredEntry[] { return this.entries.filter(e => e.line.level === LogLevel.ERROR); }
  getUserLogs(): FilteredEntry[] { return this.entries.filter(e => e.line.level === LogLevel.USER); }
  getStackTraceGroups(): StackTraceGroup[] { return this.grouper.getGroups(); }

  getDetectedFrameworks(): string[] {
    const names = this.detectedFrameworks.map(f => f.displayName);
    if (this.runtimeDetectedFramework && !names.includes(this.runtimeDetectedFramework.displayName)) {
      names.push(this.runtimeDetectedFramework.displayName);
    }
    return names;
  }

  exportAsText(): string {
    return this.getVisibleEntries().map(e => e.line.cleaned).join('\n');
  }

  onEntry(callback: (entry: FilteredEntry) => void): void { this.onEntryCallbacks.push(callback); }
  onStatsChange(callback: (stats: FilterStats) => void): void { this.onStatsChangeCallbacks.push(callback); }

  clear(resetErrorCounts = false): void {
    this.entries = [];
    this.grouper.reset();
    this.classifier.reset();
    this.stats = this.emptyStats();
    this.runtimeDetectedFramework = null;
    if (resetErrorCounts) this.errorCounts.clear();
    this.onStatsChangeCallbacks.forEach(cb => cb(this.stats));
  }

  dispose(): void {
    this.onEntryCallbacks = [];
    this.onStatsChangeCallbacks = [];
    this.entries = [];
  }
}
