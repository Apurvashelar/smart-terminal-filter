/**
 * Stack Trace Grouper — detects multi-line stack traces and groups them
 * into collapsible blocks with a summary header.
 */

import { ClassifiedLine, LogCategory } from './logClassifier';

export interface StackTraceGroup {
  id: string;
  errorMessage: string;          // The error line that triggered the trace
  lines: ClassifiedLine[];       // All lines in this stack trace
  startLine: number;
  endLine: number;
  depth: number;                 // Number of stack frames
  sourceFile?: string;           // Primary source file from first frame
  collapsed: boolean;            // UI state
}

// Patterns that start a new stack trace
const STACK_START_PATTERNS: RegExp[] = [
  /^.*Error:.*$/,
  /^.*Exception:.*$/,
  /^Traceback \(most recent call last\)/,   // Python
  /^panic:/,                                 // Go
  /^thread\s+'.*'\s+panicked\s+at/,         // Rust
  /^Unhandled rejection/i,
  /^fatal error:/i,
  /^\[ERROR\]\s+\S+\.java:\[\d+,\d+\]/,   // Maven/javac file reference: [ERROR] File.java:[26,6]
];

// Patterns that continue a stack trace
const STACK_CONTINUE_PATTERNS: RegExp[] = [
  /^\s+at\s+/,                              // JS/Java/C#
  /^\s+File\s+".*",\s+line\s+\d+/,         // Python
  /^\s+from\s+.*:\d+:in\s+/,               // Ruby
  /^\s+\S+\.go:\d+/,                       // Go
  /^\s+\|\s+\d+:/,                          // Rust backtrace (e.g. "  | 42: ...")
  /^\s+\d+:\s+0x[0-9a-f]+/,               // Generic backtrace
  /^Caused by:/i,
  /^\s+\.\.\.\s+\d+\s+more$/,             // Java condensed
  /^\s+at\s+Object\./,
  /^\s+at\s+Module\./,
  /^\s+at\s+async\s/,
  /^\s+at\s+process\./,
  // javac compiler diagnostics (follow a Maven file reference header)
  /^\s+(symbol|location)\s*:/,            // "  symbol:   class Foo"
  /^\[ERROR\]\s+(symbol|location)\s*:/,   // "[ERROR]   symbol:   class Foo"
];

export class StackTraceGrouper {
  private groups: StackTraceGroup[] = [];
  private currentGroupByTerminal: Map<string, StackTraceGroup | null> = new Map();
  private groupIdCounter = 0;
  private pendingLines: ClassifiedLine[] = [];

  /**
   * Feed a classified line. Returns the group if the line belongs to one,
   * or null if it's a standalone line.
   */
  processLine(line: ClassifiedLine): { group: StackTraceGroup | null; isNewGroup: boolean; groupComplete: boolean } {
    const cleaned = line.cleaned;
    const terminal = line.terminalName;
    const currentGroup = this.currentGroupByTerminal.get(terminal) || null;

    // Check if this line starts a new stack trace
    if (this.isStackTraceStart(cleaned)) {
      // Finalize any in-progress group for this terminal
      if (currentGroup) {
        this.groups.push(currentGroup);
      }

      // Start new group for this terminal
      const newGroup: StackTraceGroup = {
        id: `st-${++this.groupIdCounter}`,
        errorMessage: cleaned,
        lines: [line],
        startLine: line.lineNumber,
        endLine: line.lineNumber,
        depth: 0,
        collapsed: true,
      };
      this.currentGroupByTerminal.set(terminal, newGroup);

      return { group: newGroup, isNewGroup: true, groupComplete: false };
    }

    // Check if this line continues the current stack trace for this terminal
    if (currentGroup && this.isStackTraceContinuation(cleaned)) {
      currentGroup.lines.push(line);
      currentGroup.endLine = line.lineNumber;
      currentGroup.depth++;

      // Extract source from first stack frame
      if (!currentGroup.sourceFile && line.source) {
        currentGroup.sourceFile = line.source;
      }

      return { group: currentGroup, isNewGroup: false, groupComplete: false };
    }

    // This line doesn't belong to a stack trace for this terminal
    if (currentGroup) {
      this.groups.push(currentGroup);
      this.currentGroupByTerminal.set(terminal, null);
      const completedGroup = this.groups[this.groups.length - 1];
      return { group: completedGroup, isNewGroup: false, groupComplete: true };
    }

    return { group: null, isNewGroup: false, groupComplete: false };
  }

  private isStackTraceStart(line: string): boolean {
    return STACK_START_PATTERNS.some(p => p.test(line));
  }

  private isStackTraceContinuation(line: string): boolean {
    return STACK_CONTINUE_PATTERNS.some(p => p.test(line));
  }

  getGroups(): StackTraceGroup[] {
    return this.groups;
  }

  getActiveGroup(): StackTraceGroup | null {
    for (const group of this.currentGroupByTerminal.values()) {
      if (group) { return group; }
    }
    return null;
  }

  /**
   * Generate a summary for a stack trace group.
   */
  static summarize(group: StackTraceGroup): string {
    const frameCount = group.depth;
    const source = group.sourceFile || 'unknown';
    const errorMsg = group.errorMessage.length > 80
      ? group.errorMessage.substring(0, 77) + '...'
      : group.errorMessage;

    return `${errorMsg} (${frameCount} frame${frameCount !== 1 ? 's' : ''}, source: ${source})`;
  }

  reset(): void {
    this.groups = [];
    this.currentGroupByTerminal.clear();
    this.pendingLines = [];
  }
}
