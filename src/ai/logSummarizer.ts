/**
 * Log Summarizer — AI-powered batch log summarization.
 * 
 * After a command produces 100+ lines of output, generates a 2-3 sentence
 * TL;DR: "Server started successfully on port 3000. 3 deprecation warnings.
 * No errors detected."
 */

import { AIProvider, AIRequest } from './provider';
import { ClassifiedLine, LogLevel, LogCategory } from '../logClassifier';
import { FilterStats } from '../filterEngine';

export interface LogSummary {
  tldr: string;                // 2-3 sentence summary
  status: 'success' | 'warning' | 'error' | 'neutral';
  keyEvents: string[];         // Bullet points of important events
  durationMs: number;
  error?: string;
}

const SYSTEM_PROMPT = `You are a developer assistant that summarizes terminal log output.

RULES:
- Write a 2-3 sentence TL;DR of what happened.
- Lead with the outcome: success, failure, or mixed.
- Mention specific counts: errors, warnings, key events.
- Note anything unusual or actionable.
- Be terse. No filler words.

RESPONSE FORMAT:
STATUS: SUCCESS | WARNING | ERROR | NEUTRAL

SUMMARY:
[2-3 sentences]

KEY EVENTS:
- [event 1]
- [event 2]
- [event 3 if needed]`;

export class LogSummarizer {
  constructor(private aiProvider: AIProvider | null) {}

  /**
   * Summarize a batch of classified log lines.
   */
  async summarize(
    lines: ClassifiedLine[],
    stats: FilterStats
  ): Promise<LogSummary> {
    const start = Date.now();

    // If there are very few lines or no AI provider, generate a local summary
    if (lines.length < 10 || !this.aiProvider) {
      return this.localSummary(lines, stats, Date.now() - start);
    }

    // Build a condensed representation for the AI
    const condensed = this.condenseLogs(lines, stats);

    const request: AIRequest = {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: condensed,
      maxTokens: 300,
      temperature: 0.1,
    };

    const response = await this.aiProvider.complete(request);

    if (response.error) {
      // Fall back to local summary on AI failure
      const local = this.localSummary(lines, stats, Date.now() - start);
      local.error = response.error;
      return local;
    }

    return this.parseResponse(response.content, Date.now() - start);
  }

  /**
   * Condense logs into a compact representation for the AI prompt.
   * We don't send every line — we send a statistical summary + key lines.
   */
  private condenseLogs(lines: ClassifiedLine[], stats: FilterStats): string {
    const parts: string[] = [];

    parts.push(`LOG BATCH: ${stats.totalLines} total lines, ${stats.errors} errors, ${stats.warnings} warnings, ${stats.userLogs} user console statements`);
    parts.push('');

    // Include all error lines (capped at 10)
    const errors = lines.filter(l => l.level === LogLevel.ERROR).slice(0, 10);
    if (errors.length > 0) {
      parts.push('ERRORS:');
      errors.forEach(e => parts.push(`  ${e.cleaned.substring(0, 200)}`));
      parts.push('');
    }

    // Include all warning lines (capped at 5)
    const warnings = lines.filter(l => l.level === LogLevel.WARN).slice(0, 5);
    if (warnings.length > 0) {
      parts.push('WARNINGS:');
      warnings.forEach(w => parts.push(`  ${w.cleaned.substring(0, 200)}`));
      parts.push('');
    }

    // Include status changes
    const statuses = lines.filter(l => l.level === LogLevel.STATUS).slice(0, 5);
    if (statuses.length > 0) {
      parts.push('STATUS EVENTS:');
      statuses.forEach(s => parts.push(`  ${s.cleaned.substring(0, 200)}`));
      parts.push('');
    }

    // Include user console output
    const userLogs = lines.filter(l => l.level === LogLevel.USER).slice(0, 5);
    if (userLogs.length > 0) {
      parts.push('USER CONSOLE OUTPUT:');
      userLogs.forEach(u => parts.push(`  ${u.cleaned.substring(0, 200)}`));
      parts.push('');
    }

    // First and last 3 lines for context
    parts.push('FIRST LINES:');
    lines.slice(0, 3).forEach(l => parts.push(`  ${l.cleaned.substring(0, 200)}`));
    parts.push('');
    parts.push('LAST LINES:');
    lines.slice(-3).forEach(l => parts.push(`  ${l.cleaned.substring(0, 200)}`));

    parts.push('');
    parts.push('Summarize this log output.');

    return parts.join('\n');
  }

  /**
   * Fast local summary without AI — used for small batches or as fallback.
   */
  private localSummary(lines: ClassifiedLine[], stats: FilterStats, durationMs: number): LogSummary {
    const parts: string[] = [];
    const keyEvents: string[] = [];

    // Determine status
    let status: LogSummary['status'] = 'neutral';
    if (stats.errors > 0) { status = 'error'; }
    else if (stats.warnings > 0) { status = 'warning'; }

    // Check for success indicators
    const hasSuccess = lines.some(l =>
      l.level === LogLevel.STATUS &&
      /\b(success|ready|started|compiled|listening|running)\b/i.test(l.cleaned)
    );
    if (hasSuccess && stats.errors === 0) { status = 'success'; }

    // Build TL;DR
    if (hasSuccess && stats.errors === 0) {
      parts.push('Completed successfully.');
    } else if (stats.errors > 0) {
      parts.push(`Failed with ${stats.errors} error${stats.errors > 1 ? 's' : ''}.`);
    }

    if (stats.warnings > 0) {
      parts.push(`${stats.warnings} warning${stats.warnings > 1 ? 's' : ''} detected.`);
    }

    if (stats.userLogs > 0) {
      parts.push(`${stats.userLogs} console statement${stats.userLogs > 1 ? 's' : ''} captured.`);
    }

    if (parts.length === 0) {
      parts.push(`${stats.totalLines} lines of output processed.`);
    }

    // Key events
    const errors = lines.filter(l => l.level === LogLevel.ERROR && l.category !== LogCategory.STACK_TRACE);
    errors.slice(0, 3).forEach(e => {
      keyEvents.push(e.cleaned.substring(0, 100));
    });

    const statuses = lines.filter(l => l.level === LogLevel.STATUS);
    statuses.slice(0, 2).forEach(s => {
      keyEvents.push(s.cleaned.substring(0, 100));
    });

    return {
      tldr: parts.join(' '),
      status,
      keyEvents,
      durationMs,
    };
  }

  private parseResponse(content: string, durationMs: number): LogSummary {
    let status: LogSummary['status'] = 'neutral';
    let tldr = '';
    const keyEvents: string[] = [];

    // Extract STATUS
    const statusMatch = content.match(/STATUS:\s*(SUCCESS|WARNING|ERROR|NEUTRAL)/i);
    if (statusMatch) {
      status = statusMatch[1].toLowerCase() as LogSummary['status'];
    }

    // Extract SUMMARY
    const summaryMatch = content.match(/SUMMARY:\s*\n([\s\S]*?)(?=\nKEY EVENTS:|$)/i);
    if (summaryMatch) {
      tldr = summaryMatch[1].trim();
    } else {
      // Fallback: use first non-status line
      const lines = content.split('\n').filter(l => !l.startsWith('STATUS:') && l.trim());
      tldr = lines.slice(0, 2).join(' ').trim();
    }

    // Extract KEY EVENTS
    const eventsMatch = content.match(/KEY EVENTS:\s*\n([\s\S]*?)$/i);
    if (eventsMatch) {
      const eventLines = eventsMatch[1].split('\n')
        .map(l => l.replace(/^[\s-*•]+/, '').trim())
        .filter(l => l.length > 0);
      keyEvents.push(...eventLines.slice(0, 5));
    }

    return { tldr, status, keyEvents, durationMs };
  }
}
