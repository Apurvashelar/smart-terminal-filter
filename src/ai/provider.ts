/**
 * AI Provider — unified interface for Claude, OpenAI, and Ollama.
 * 
 * Abstracts the LLM backend so all AI features (error explanation,
 * log summarization, natural language queries) work with any provider.
 */

import * as https from 'https';
import * as http from 'http';

export interface AIProviderConfig {
  provider: 'claude' | 'openai' | 'ollama';
  apiKey?: string;
  model?: string;
  baseUrl?: string;          // For Ollama or custom endpoints
  maxTokens?: number;
  temperature?: number;
}

export interface AIRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  error?: string;
  durationMs: number;
}

const DEFAULT_MODELS: Record<string, string> = {
  claude: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1',
};

export class AIProvider {
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = {
      ...config,
      model: config.model || DEFAULT_MODELS[config.provider] || 'claude-sonnet-4-20250514',
      maxTokens: config.maxTokens || 1024,
      temperature: config.temperature ?? 0.3,
    };
  }

  async complete(request: AIRequest): Promise<AIResponse> {
    const start = Date.now();
    try {
      switch (this.config.provider) {
        case 'claude':
          return await this.callClaude(request, start);
        case 'openai':
          return await this.callOpenAI(request, start);
        case 'ollama':
          return await this.callOllama(request, start);
        default:
          return { content: '', error: `Unknown provider: ${this.config.provider}`, durationMs: Date.now() - start };
      }
    } catch (err: any) {
      return { content: '', error: err.message || String(err), durationMs: Date.now() - start };
    }
  }

  // ---------------------------------------------------------------------------
  // Claude (Anthropic API)
  // ---------------------------------------------------------------------------
  private async callClaude(request: AIRequest, start: number): Promise<AIResponse> {
    if (!this.config.apiKey) {
      return { content: '', error: 'Claude API key not configured. Set smartTerminal.ai.apiKey in settings.', durationMs: Date.now() - start };
    }

    const body = JSON.stringify({
      model: this.config.model,
      max_tokens: request.maxTokens || this.config.maxTokens,
      temperature: request.temperature ?? this.config.temperature,
      system: request.systemPrompt,
      messages: [
        { role: 'user', content: request.userPrompt },
      ],
    });

    const response = await this.httpRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, body);

    const data = JSON.parse(response);
    if (data.error) {
      return { content: '', error: data.error.message || JSON.stringify(data.error), durationMs: Date.now() - start };
    }

    const content = data.content?.map((c: any) => c.text || '').join('') || '';
    return {
      content,
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      durationMs: Date.now() - start,
    };
  }

  // ---------------------------------------------------------------------------
  // OpenAI
  // ---------------------------------------------------------------------------
  private async callOpenAI(request: AIRequest, start: number): Promise<AIResponse> {
    if (!this.config.apiKey) {
      return { content: '', error: 'OpenAI API key not configured. Set smartTerminal.ai.apiKey in settings.', durationMs: Date.now() - start };
    }

    const body = JSON.stringify({
      model: this.config.model,
      max_tokens: request.maxTokens || this.config.maxTokens,
      temperature: request.temperature ?? this.config.temperature,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
    });

    const baseUrl = this.config.baseUrl || 'https://api.openai.com';
    const url = new URL(baseUrl);

    const response = await this.httpRequest({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
    }, body);

    const data = JSON.parse(response);
    if (data.error) {
      return { content: '', error: data.error.message || JSON.stringify(data.error), durationMs: Date.now() - start };
    }

    const content = data.choices?.[0]?.message?.content || '';
    return {
      content,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      durationMs: Date.now() - start,
    };
  }

  // ---------------------------------------------------------------------------
  // Ollama (local)
  // ---------------------------------------------------------------------------
  private async callOllama(request: AIRequest, start: number): Promise<AIResponse> {
    const baseUrl = this.config.baseUrl || 'http://localhost:11434';
    const url = new URL(baseUrl);

    const body = JSON.stringify({
      model: this.config.model,
      stream: false,
      system: request.systemPrompt,
      prompt: request.userPrompt,
      options: {
        temperature: request.temperature ?? this.config.temperature,
        num_predict: request.maxTokens || this.config.maxTokens,
      },
    });

    const response = await this.httpRequest({
      hostname: url.hostname,
      port: parseInt(url.port) || 11434,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, body, url.protocol === 'http:');

    const data = JSON.parse(response);
    if (data.error) {
      return { content: '', error: data.error, durationMs: Date.now() - start };
    }

    return {
      content: data.response || '',
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
      durationMs: Date.now() - start,
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP helper
  // ---------------------------------------------------------------------------
  private httpRequest(options: any, body: string, useHttp = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const lib = useHttp ? http : https;
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout (30s)'));
      });
      req.write(body);
      req.end();
    });
  }

  getProviderName(): string {
    return this.config.provider;
  }

  getModelName(): string {
    return this.config.model || 'unknown';
  }
}
