/**
 * Error Explainer — AI-powered error analysis.
 * 
 * Given an error message, stack trace, and surrounding source code,
 * produces:
 *   1. Plain-English explanation of what went wrong
 *   2. Root cause identification
 *   3. Suggested fix (with code diff when possible)
 *   4. Confidence score
 */

import * as fs from 'fs';
import * as path from 'path';
import { AIProvider, AIRequest } from './provider';
import { StackTraceGroup } from '../stackTraceGrouper';
import { ClassifiedLine } from '../logClassifier';

export interface ErrorExplanation {
  summary: string;          // One-sentence plain-English explanation
  rootCause: string;        // What actually caused the error
  suggestedFix: string;     // How to fix it
  codeSnippet?: string;     // Fixed code if applicable
  confidence: 'high' | 'medium' | 'low';
  relatedDocs?: string;     // Link to relevant docs
  durationMs: number;
  error?: string;           // If AI call failed
}

const SYSTEM_PROMPT = `You are an expert debugger embedded in a developer's IDE terminal. Your job is to explain errors clearly and suggest fixes.

RULES:
- Be concise. Developers are busy.
- Lead with WHAT happened, then WHY, then HOW TO FIX.
- If you can provide a code fix, output ONLY the exact replacement line(s) for the error line. Never include surrounding context, unchanged lines, or setup code that already exists.
- Don't be patronizing. Assume the developer is competent.
- If the error is ambiguous, say so and list the most likely causes.

RESPONSE FORMAT (use exactly these headers):
## Summary
One sentence explaining the error in plain English.

## Root cause
What specifically caused this error. Reference the file and line if known.

## Fix
Step-by-step fix. If the fix requires a code change, provide ONLY the corrected line(s) that directly replace the error line — no surrounding context, no imports, no other unchanged lines.

\`\`\`
// ONLY the corrected line(s) — nothing else
\`\`\`

## Confidence
HIGH / MEDIUM / LOW — and briefly why.`;

export class ErrorExplainer {
  constructor(private aiProvider: AIProvider) {}

  /**
   * Explain a single error line with optional source context.
   */
  async explain(
    errorLine: ClassifiedLine,
    stackGroup?: StackTraceGroup,
    workspaceRoot?: string
  ): Promise<ErrorExplanation> {
    const start = Date.now();

    // Build context
    const errorText = errorLine.cleaned;
    const stackTrace = stackGroup
      ? stackGroup.lines.map(l => l.cleaned).join('\n')
      : '';

    // Try to read source file around the error
    let sourceContext = '';
    const sourceFile = stackGroup?.sourceFile || errorLine.source;
    if (sourceFile && workspaceRoot) {
      sourceContext = this.readSourceContext(sourceFile, workspaceRoot);
    }

    // Build prompt
    const userPrompt = this.buildPrompt(errorText, stackTrace, sourceContext);

    const request: AIRequest = {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 800,
      temperature: 0.2,
    };

    const response = await this.aiProvider.complete(request);

    if (response.error) {
      return {
        summary: 'AI analysis failed',
        rootCause: '',
        suggestedFix: '',
        confidence: 'low',
        durationMs: Date.now() - start,
        error: response.error,
      };
    }

    return this.parseResponse(response.content, Date.now() - start);
  }

  /**
   * Batch explain: explain the most critical errors from a set of entries.
   */
  async explainTopErrors(
    errors: ClassifiedLine[],
    stackGroups: Map<string, StackTraceGroup>,
    workspaceRoot?: string,
    maxErrors: number = 3
  ): Promise<ErrorExplanation[]> {
    const topErrors = errors.slice(0, maxErrors);
    const results: ErrorExplanation[] = [];

    for (const error of topErrors) {
      // Find the stack group for this error if it exists
      let group: StackTraceGroup | undefined;
      for (const [, g] of stackGroups) {
        if (g.lines.some(l => l.lineNumber === error.lineNumber)) {
          group = g;
          break;
        }
      }

      const explanation = await this.explain(error, group, workspaceRoot);
      results.push(explanation);
    }

    return results;
  }

  private buildPrompt(errorText: string, stackTrace: string, sourceContext: string): string {
    let prompt = `ERROR:\n${errorText}\n`;

    if (stackTrace) {
      prompt += `\nSTACK TRACE:\n${stackTrace}\n`;
    }

    if (sourceContext) {
      prompt += `\nSOURCE CODE (around the error location):\n${sourceContext}\n`;
    }

    prompt += '\nExplain this error and suggest a fix.';
    return prompt;
  }

  /**
   * Read ~10 lines of source code around the error location.
   */
  private readSourceContext(sourceRef: string, workspaceRoot: string): string {
    try {
      const match = sourceRef.match(/^(.+):(\d+)(?::(\d+))?$/);
      if (!match) { return ''; }

      let filePath = match[1];
      const lineNum = parseInt(match[2], 10);

      // Resolve relative paths and guard against traversal outside workspace
      if (!path.isAbsolute(filePath)) {
        const resolved = path.resolve(workspaceRoot, filePath);
        if (!resolved.startsWith(path.resolve(workspaceRoot) + path.sep)) { return ''; }
        filePath = resolved;
      }

      if (!fs.existsSync(filePath)) { return ''; }

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      // Extract surrounding lines (5 before, 5 after)
      const start = Math.max(0, lineNum - 6);
      const end = Math.min(lines.length, lineNum + 5);

      const contextLines = lines.slice(start, end).map((line, i) => {
        const num = start + i + 1;
        const marker = num === lineNum ? ' >>> ' : '     ';
        return `${marker}${num}: ${line}`;
      });

      return `File: ${filePath}\n${contextLines.join('\n')}`;
    } catch {
      return '';
    }
  }

  private parseResponse(content: string, durationMs: number): ErrorExplanation {
    const sections = this.extractSections(content);

    let confidence: 'high' | 'medium' | 'low' = 'medium';
    const confText = (sections['confidence'] || '').toLowerCase();
    if (confText.includes('high')) { confidence = 'high'; }
    else if (confText.includes('low')) { confidence = 'low'; }

    // Extract code block from the fix section
    let codeSnippet: string | undefined;
    const fixSection = sections['fix'] || '';
    const codeMatch = fixSection.match(/```[\w]*\n([\s\S]*?)```/);
    if (codeMatch) {
      codeSnippet = codeMatch[1].trim();
    }

    return {
      summary: sections['summary'] || content.split('\n')[0] || 'Error analysis complete',
      rootCause: sections['root cause'] || sections['rootcause'] || '',
      suggestedFix: fixSection.replace(/```[\w]*\n[\s\S]*?```/g, '').trim(),
      codeSnippet,
      confidence,
      durationMs,
    };
  }

  private extractSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const regex = /##\s+(.+?)(?:\n)([\s\S]*?)(?=##\s+|\s*$)/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const key = match[1].trim().toLowerCase();
      const value = match[2].trim();
      sections[key] = value;
    }

    return sections;
  }
}
