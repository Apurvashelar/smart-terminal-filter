/**
 * Command Generator — AI-powered natural language to shell command translation.
 *
 * Given a natural language description, generates the corresponding shell command
 * with explanation and safety classification.
 */

import { AIProvider, AIRequest } from './provider';

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
  error?: string;            // If AI call failed
}

const SYSTEM_PROMPT = `You are a shell command generator embedded in a developer's terminal. The user will describe what they want to do in natural language, and you translate it into a shell command.

RULES:
- Output EXACTLY three lines, nothing else.
- Line 1: The shell command only. No backticks, no markdown, no explanation.
- Line 2: One-sentence explanation of what the command does.
- Line 3: "DESTRUCTIVE" if the command modifies/deletes data (rm, mv overwrite, DROP, truncate, chmod, etc.), "SAFE" otherwise.
- Use the platform and shell information to generate the correct command syntax.
- Prefer simple, common commands over complex one-liners.
- If the request is ambiguous, pick the most likely interpretation and explain in line 2.`;

export class CommandGenerator {
  constructor(private ai: AIProvider) {}

  async generate(naturalLanguageInput: string, context: CommandContext): Promise<GeneratedCommand> {
    const start = Date.now();

    const userPrompt = `Platform: ${context.platform}
Shell: ${context.shell}
Working directory: ${context.cwd}
${context.recentCommands.length > 0 ? `Recent commands:\n${context.recentCommands.map(c => '  $ ' + c).join('\n')}` : ''}

User request: ${naturalLanguageInput}`;

    const request: AIRequest = {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 200,
      temperature: 0.1,
    };

    const response = await this.ai.complete(request);

    if (response.error) {
      return {
        command: '',
        explanation: '',
        confidence: 'low',
        isDestructive: false,
        durationMs: Date.now() - start,
        error: response.error,
      };
    }

    return this.parseResponse(response.content, Date.now() - start);
  }

  private parseResponse(content: string, durationMs: number): GeneratedCommand {
    // Strip markdown code fences if AI wrapped the response
    const stripped = content.replace(/```[\w]*\n?/g, '').replace(/```/g, '');
    const lines = stripped.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Strip leading `$ ` that AI sometimes adds despite instructions
    const rawCommand = lines[0] || '';
    const command = rawCommand.replace(/^\$\s+/, '');
    const explanation = lines[1] || '';
    const safetyLine = (lines[2] || '').toUpperCase();
    const isDestructive = safetyLine.includes('DESTRUCTIVE');

    // Heuristic confidence: if command is non-empty and explanation exists, high confidence
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    if (command && explanation) {
      confidence = 'high';
    } else if (!command) {
      confidence = 'low';
    }

    return {
      command,
      explanation,
      confidence,
      isDestructive,
      durationMs,
    };
  }
}
