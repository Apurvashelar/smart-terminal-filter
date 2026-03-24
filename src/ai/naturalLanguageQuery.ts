import { AIProvider, AIRequest } from './provider';
import { ClassifiedLine, LogLevel } from '../logClassifier';

export interface QueryResult { matchedLines: ClassifiedLine[]; explanation: string; filterUsed: string; totalScanned: number; durationMs: number; usedAI: boolean; conversationalResponse?: string; }

const LOCAL_PATTERNS: Array<{ pattern: RegExp; filter: (lines: ClassifiedLine[], match: RegExpMatchArray) => ClassifiedLine[]; description: string }> = [
  { pattern: /\b(errors?|exceptions?|failures?|crashes?)\b/i, filter: lines => lines.filter(l => l.level === LogLevel.ERROR), description: 'All error-level messages' },
  { pattern: /\b(warnings?|deprecat|caution)\b/i, filter: lines => lines.filter(l => l.level === LogLevel.WARN), description: 'All warning-level messages' },
  { pattern: /\bmy\s*(logs?|output|console|prints?)\b/i, filter: lines => lines.filter(l => l.level === LogLevel.USER), description: 'Your console/print statements' },
  { pattern: /\b(status|startup|started|ready|listening|boot)\b/i, filter: lines => lines.filter(l => l.level === LogLevel.STATUS), description: 'Server status events' },
  { pattern: /\b(slow|timeout|took more than|longer than|>\s*(\d+)\s*ms)\b/i, filter: (lines, match) => { const t = match[2] ? parseInt(match[2], 10) : 100; return lines.filter(l => { const m = l.cleaned.match(/(\d+)\s*ms/); return m !== null && parseInt(m[1], 10) > t; }); }, description: 'Slow operations exceeding threshold' },
  { pattern: /\b(database|db|sql|query|queries|postgres|mysql|mongo|redis)\b/i, filter: lines => lines.filter(l => /\b(SELECT|INSERT|UPDATE|DELETE|query|sql|db|database|postgres|mysql|mongo|redis)\b/i.test(l.cleaned)), description: 'Database-related log lines' },
  { pattern: /\b(auth|login|logout|session|token|jwt|unauthorized|forbidden|401|403)\b/i, filter: lines => lines.filter(l => /\b(auth|login|logout|session|token|jwt|unauthorized|forbidden|401|403|denied)\b/i.test(l.cleaned)), description: 'Auth events' },
  { pattern: /\b(memory|heap|gc|garbage|OOM|RSS)\b/i, filter: lines => lines.filter(l => /\b(memory|heap|gc|garbage|OOM|RSS|leak|out of memory)\b/i.test(l.cleaned)), description: 'Memory-related lines' },
  { pattern: /\blast\s+(\d+)\s*(lines?|entries)\b/i, filter: (lines, match) => lines.slice(-parseInt(match[1], 10)), description: 'Last N lines' },
  { pattern: /\bfirst\s+(\d+)\s*(lines?|entries)\b/i, filter: (lines, match) => lines.slice(0, parseInt(match[1], 10)), description: 'First N lines' },
];

const AI_SYS = 'Given a query about logs, return a JS regex.\nFORMAT:\nREGEX: <pattern>\nEXPLANATION: <one sentence>';
const QUESTION_PATTERN = /\b(what|why|how|explain|mean|means|cause|causes|fix|solve|tell me|describe|understand|happened)\b/i;

export class NaturalLanguageQuery {
  constructor(private ai?: AIProvider) {}

  async query(question: string, allLines: ClassifiedLine[]): Promise<QueryResult> {
    const start = Date.now();
    // Route question-style queries to conversational AI first
    if (QUESTION_PATTERN.test(question) && this.ai) {
      return this.aiConversation(question, allLines, start);
    }
    for (const { pattern, filter, description } of LOCAL_PATTERNS) {
      const match = question.match(pattern);
      if (match) return { matchedLines: filter(allLines, match), explanation: description, filterUsed: pattern.source, totalScanned: allLines.length, durationMs: Date.now() - start, usedAI: false };
    }
    if (this.ai) return this.aiQuery(question, allLines, start);
    return this.fallback(question, allLines, Date.now() - start);
  }

  private async aiConversation(question: string, lines: ClassifiedLine[], start: number): Promise<QueryResult> {
    const errors = lines.filter(l => l.level === LogLevel.ERROR);
    const context = errors.slice(-10).map(l => l.cleaned).join('\n') || lines.slice(-20).map(l => l.cleaned).join('\n');
    const systemPrompt = 'You are a developer assistant helping debug terminal output. Answer the user\'s question directly and concisely. Identify the root cause, explain what it means in plain English, and suggest a fix. Be practical and specific.';
    const userPrompt = `Terminal output:\n\`\`\`\n${context}\n\`\`\`\n\nQuestion: ${question}`;
    const resp = await this.ai!.complete({ systemPrompt, userPrompt, maxTokens: 512, temperature: 0.3 });
    if (resp.error) {
      return { matchedLines: errors, explanation: 'AI unavailable: ' + resp.error, filterUsed: '', totalScanned: lines.length, durationMs: Date.now() - start, usedAI: false };
    }
    return { matchedLines: errors, explanation: 'AI answer', filterUsed: '', totalScanned: lines.length, durationMs: Date.now() - start, usedAI: true, conversationalResponse: resp.content };
  }

  private async aiQuery(question: string, lines: ClassifiedLine[], start: number): Promise<QueryResult> {
    const resp = await this.ai!.complete({ systemPrompt: AI_SYS, userPrompt: 'Query: "' + question + '"', maxTokens: 200, temperature: 0.1 });
    if (resp.error) { const fb = this.fallback(question, lines, Date.now() - start); fb.explanation += ' (AI unavailable)'; return fb; }
    const rm = resp.content.match(/REGEX:\s*(.+)/i);
    if (!rm) return this.fallback(question, lines, Date.now() - start);
    try {
      const regex = new RegExp(rm[1].trim(), 'i');
      const em = resp.content.match(/EXPLANATION:\s*(.+)/i);
      return { matchedLines: lines.filter(l => regex.test(l.cleaned)), explanation: em ? em[1].trim() : 'AI filter', filterUsed: rm[1].trim(), totalScanned: lines.length, durationMs: Date.now() - start, usedAI: true };
    } catch { return this.fallback(question, lines, Date.now() - start); }
  }

  private fallback(question: string, lines: ClassifiedLine[], durationMs: number): QueryResult {
    const stop = new Set(['show','me','the','all','find','where','what','why','how','a','an','in','of','to','from','with','and','or','for','that','this','my']);
    const kw = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stop.has(w));
    if (!kw.length) return { matchedLines: [], explanation: 'Could not parse query', filterUsed: '', totalScanned: lines.length, durationMs, usedAI: false };
    return { matchedLines: lines.filter(l => kw.some(k => l.cleaned.toLowerCase().includes(k))), explanation: 'Text search: ' + kw.join(', '), filterUsed: kw.join('|'), totalScanned: lines.length, durationMs, usedAI: false };
  }
}
