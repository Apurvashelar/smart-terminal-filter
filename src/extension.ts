/**
 * Smart Terminal Filter — Extension Entry Point v0.2.0
 *
 * Panel lives in secondary sidebar (right side of VS Code).
 * Terminal stays at the bottom. Both visible simultaneously.
 * Toast notifications fire when new output/errors are detected.
 */

import * as vscode from 'vscode';
import { LogInterceptor } from './logInterceptor';
import { FilterEngine, VerbosityLevel } from './filterEngine';
import { WebviewPanel } from './webviewPanel';
import { StatusBarController } from './statusBar';
import { AIProvider, AIProviderConfig } from './ai/provider';
import { ErrorExplainer } from './ai/errorExplainer';
import { LogSummarizer } from './ai/logSummarizer';
import { NaturalLanguageQuery } from './ai/naturalLanguageQuery';

let interceptor: LogInterceptor;
let engine: FilterEngine;
let panel: WebviewPanel;
let statusBar: StatusBarController;
let aiProvider: AIProvider | null = null;
let errorExplainer: ErrorExplainer | null = null;
let logSummarizer: LogSummarizer | null = null;
let nlQuery: NaturalLanguageQuery | null = null;
let extensionContext: vscode.ExtensionContext;

const SECRET_KEY = 'smartTerminal.apiKey';

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const config = vscode.workspace.getConfiguration('smartTerminal');
  const verbosity = (config.get<number>('verbosityLevel') || 2) as VerbosityLevel;
  const maxLines = config.get<number>('maxLogLines') || 5000;
  const frameworkDetection = config.get<boolean>('frameworkDetection') !== false;
  const customNoise = config.get<string[]>('customNoisePatterns') || [];
  const customSignal = config.get<string[]>('customSignalPatterns') || [];

  interceptor = new LogInterceptor();
  engine = new FilterEngine(maxLines);
  panel = new WebviewPanel(context);
  statusBar = new StatusBarController();

  engine.setVerbosity(verbosity);
  engine.setCustomPatterns(customNoise, customSignal);
  statusBar.updateVerbosity(verbosity);

  // Register panel in secondary sidebar (Feature 4)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WebviewPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  if (frameworkDetection && vscode.workspace.workspaceFolders?.length) {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const frameworks = engine.detectFrameworks(root);
    if (frameworks.length > 0) panel.sendFrameworks(frameworks);
  }

  initializeAI(config, context);

  // --- Data pipeline ---
  interceptor.onCommandStart(() => {
    engine.clear(true); panel.sendClear(); statusBar.resetErrorTracking();
  });

  interceptor.onData(data => {
    const entries = engine.processData(data.data, data.terminalName);
    for (const entry of entries) panel.sendEntry(entry);
  });

  engine.onStatsChange(stats => {
    statusBar.updateStats(stats); // handles flash + toast (Feature 3)
    panel.sendStats(stats);       // updates banner (Feature 1)
  });
  engine.onRetroactiveHide(groupId => panel.sendHideStackGroup(groupId));
  engine.onRetroactiveHideEntry(lineNumber => panel.sendHideEntry(lineNumber));

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('smartTerminal.openPanel', () => {
      panel.show();
      panel.sendBulkEntries(engine.getVisibleEntries());
      panel.sendStats(engine.getStats());
      panel.sendVerbosity(engine.getVerbosity());
      const fw = engine.getDetectedFrameworks();
      if (fw.length > 0) panel.sendFrameworks(fw);
      panel.sendAIStatus(aiProvider !== null);
    }),
    vscode.commands.registerCommand('smartTerminal.clearLogs', () => {
      engine.clear(true); panel.sendClear(); statusBar.resetErrorTracking();
    }),
    vscode.commands.registerCommand('smartTerminal.toggleCapture', () => {
      if (interceptor.isActive()) { interceptor.pause(); statusBar.updateCapture(false); }
      else { interceptor.resume(); statusBar.updateCapture(true); }
    }),
    vscode.commands.registerCommand('smartTerminal.setVerbosity', async () => {
      const items = [1,2,3,4,5].map(n => ({ label: `${n}`, description: ['Errors only','+Warnings','+Status','+Verbose','Raw'][n-1] }));
      const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Verbosity' });
      if (sel) {
        const level = parseInt(sel.label, 10) as VerbosityLevel;
        engine.setVerbosity(level); statusBar.updateVerbosity(level); panel.sendVerbosity(level);
        panel.sendClear(); panel.sendBulkEntries(engine.getVisibleEntries()); panel.sendStats(engine.getStats());
      }
    }),
    vscode.commands.registerCommand('smartTerminal.exportLogs', async () => {
      const text = engine.exportAsText();
      if (!text) { vscode.window.showInformationMessage('No logs to export'); return; }
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'log' });
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('smartTerminal.setApiKey', async () => {
      const config = vscode.workspace.getConfiguration('smartTerminal');
      const provider = config.get<string>('ai.provider') || 'claude';
      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key`,
        password: true,
        placeHolder: provider === 'openai' ? 'sk-...' : 'sk-ant-...',
        ignoreFocusOut: true,
      });
      if (!key) return;
      await context.secrets.store(SECRET_KEY, key);
      await initializeAI(config, context);
      panel.sendAIStatus(aiProvider !== null);
      vscode.window.showInformationMessage('Smart Terminal: API key saved securely to OS keychain.');
    }),
    vscode.commands.registerCommand('smartTerminal.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      const config = vscode.workspace.getConfiguration('smartTerminal');
      await initializeAI(config, context);
      panel.sendAIStatus(false);
      vscode.window.showInformationMessage('Smart Terminal: API key cleared.');
    }),
    vscode.commands.registerCommand('smartTerminal.explainError', async () => {
      if (!errorExplainer) {
        const ok = await promptForApiKey(context);
        if (!ok || !errorExplainer) return;
      }
      const errors = engine.getErrors();
      if (errors.length === 0) { vscode.window.showInformationMessage('No errors to explain.'); return; }
      panel.show(); panel.sendAILoading('Analyzing error...');
      const last = errors[errors.length - 1];
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const explanation = await errorExplainer.explain(last.line, last.stackGroup, wsRoot);
      panel.sendErrorExplanation(explanation);
    }),
    vscode.commands.registerCommand('smartTerminal.summarizeLogs', async () => {
      const allLines = engine.getAllEntries().map(e => e.line);
      const stats = engine.getStats();
      if (allLines.length === 0) { vscode.window.showInformationMessage('No logs to summarize.'); return; }
      panel.show(); panel.sendAILoading('Generating summary...');
      const summarizer = logSummarizer || new LogSummarizer(null as any);
      const summary = await summarizer.summarize(allLines, stats);
      panel.sendLogSummary(summary);
    }),
    vscode.commands.registerCommand('smartTerminal.queryLogs', async () => {
      const question = await vscode.window.showInputBox({ prompt: 'Ask about your logs', placeHolder: 'e.g., "show me slow database queries"' });
      if (!question) return;
      const allLines = engine.getAllEntries().map(e => e.line);
      if (allLines.length === 0) { vscode.window.showInformationMessage('No logs to query.'); return; }
      panel.show(); panel.sendAILoading(`Searching: "${question}"...`);
      const qe = nlQuery || new NaturalLanguageQuery();
      const result = await qe.query(question, allLines);
      panel.sendQueryResult(result);
    }),
  );

  // --- Webview messages ---
  panel.onMessage('setVerbosity', (msg: any) => {
    const level = msg.level as VerbosityLevel;
    engine.setVerbosity(level); statusBar.updateVerbosity(level);
    panel.sendClear(); panel.sendBulkEntries(engine.getVisibleEntries()); panel.sendStats(engine.getStats());
  });
  panel.onMessage('clearLogs', () => { engine.clear(true); panel.sendClear(); statusBar.resetErrorTracking(); });
  panel.onMessage('exportLogs', () => vscode.commands.executeCommand('smartTerminal.exportLogs'));
  panel.onMessage('openFile', (msg: any) => {
    const source = msg.source as string; if (!source) return;
    const match = source.match(/^(.+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?$/); if (!match) return;
    const uri = findFileUri(match[1]);
    if (uri) {
      const line = parseInt(match[2], 10) - 1;
      const col = match[3] ? parseInt(match[3], 10) - 1 : 0;
      vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, col, line, col) });
    }
  });
  panel.onMessage('explainError', () => vscode.commands.executeCommand('smartTerminal.explainError'));
  panel.onMessage('summarizeLogs', () => vscode.commands.executeCommand('smartTerminal.summarizeLogs'));
  panel.onMessage('queryLogs', async (msg: any) => {
    if (!msg.question) return;
    const allLines = engine.getAllEntries().map(e => e.line);
    panel.sendAILoading(`Searching: "${msg.question}"...`);
    const qe = nlQuery || new NaturalLanguageQuery();
    const result = await qe.query(msg.question, allLines);
    panel.sendQueryResult(result);
  });

  // --- Config changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('smartTerminal')) return;
      const c = vscode.workspace.getConfiguration('smartTerminal');
      engine.setVerbosity((c.get<number>('verbosityLevel') || 2) as VerbosityLevel);
      engine.setCustomPatterns(c.get<string[]>('customNoisePatterns') || [], c.get<string[]>('customSignalPatterns') || []);
      if (e.affectsConfiguration('smartTerminal.ai')) {
        initializeAI(c, context).then(() => panel.sendAIStatus(aiProvider !== null));
      }
    }),
    context.secrets.onDidChange(e => {
      if (e.key === SECRET_KEY) {
        const c = vscode.workspace.getConfiguration('smartTerminal');
        initializeAI(c, context).then(() => panel.sendAIStatus(aiProvider !== null));
      }
    })
  );

  interceptor.activate();
  context.subscriptions.push({ dispose: () => { interceptor.dispose(); engine.dispose(); panel.dispose(); statusBar.dispose(); } });
}

export function deactivate(): void {
  interceptor?.dispose(); engine?.dispose(); panel?.dispose(); statusBar?.dispose();
}

async function initializeAI(config: vscode.WorkspaceConfiguration, ctx: vscode.ExtensionContext): Promise<void> {
  const provider = config.get<string>('ai.provider') || 'claude';
  const apiKey = provider !== 'ollama' ? (await ctx.secrets.get(SECRET_KEY) || '') : '';
  const model = config.get<string>('ai.model') || '';
  const baseUrl = config.get<string>('ai.baseUrl') || '';
  if (provider !== 'ollama' && !apiKey) {
    aiProvider = null; errorExplainer = null; logSummarizer = null;
    nlQuery = new NaturalLanguageQuery(); return;
  }
  const cfg: AIProviderConfig = { provider: provider as any, apiKey: apiKey || undefined, model: model || undefined, baseUrl: baseUrl || undefined };
  aiProvider = new AIProvider(cfg);
  errorExplainer = new ErrorExplainer(aiProvider);
  logSummarizer = new LogSummarizer(aiProvider);
  nlQuery = new NaturalLanguageQuery(aiProvider);
}

async function promptForApiKey(ctx: vscode.ExtensionContext): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('smartTerminal');
  const provider = config.get<string>('ai.provider') || 'claude';
  const key = await vscode.window.showInputBox({
    prompt: `No API key set. Enter your ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key to enable AI features`,
    password: true,
    placeHolder: provider === 'openai' ? 'sk-...' : 'sk-ant-...',
    ignoreFocusOut: true,
  });
  if (!key) return false;
  await ctx.secrets.store(SECRET_KEY, key);
  await initializeAI(config, ctx);
  panel.sendAIStatus(aiProvider !== null);
  vscode.window.showInformationMessage('Smart Terminal: API key saved securely to OS keychain.');
  return true;
}

function findFileUri(filePath: string): vscode.Uri | null {
  if (filePath.startsWith('/') || /^[A-Z]:\\/.test(filePath)) return vscode.Uri.file(filePath);
  const folders = vscode.workspace.workspaceFolders;
  return folders?.length ? vscode.Uri.joinPath(folders[0].uri, filePath) : null;
}
