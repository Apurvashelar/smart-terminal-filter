/**
 * Log Classifier — the brain of the filtering system.
 * 
 * Classifies every terminal line into:
 *   - LogLevel (error, warn, info, debug, trace, user, unknown)
 *   - Noise score (0-100, higher = more noise)
 *   - Category (stacktrace, framework_banner, build_output, user_code, server_status, etc.)
 */

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  TRACE = 'trace',
  USER = 'user',       // User's own console.log / print statements
  STATUS = 'status',   // Server started, build complete, etc.
  UNKNOWN = 'unknown',
}

export enum LogCategory {
  ERROR_MESSAGE = 'error_message',
  STACK_TRACE = 'stack_trace',
  WARNING = 'warning',
  USER_CONSOLE = 'user_console',
  SERVER_STATUS = 'server_status',
  BUILD_OUTPUT = 'build_output',
  FRAMEWORK_BANNER = 'framework_banner',
  FRAMEWORK_NOISE = 'framework_noise',
  DEPENDENCY_LOG = 'dependency_log',
  TIMESTAMP_ONLY = 'timestamp_only',
  BLANK_OR_SEPARATOR = 'blank_or_separator',
  ANSI_CONTROL = 'ansi_control',
  UNKNOWN = 'unknown',
}

export interface ClassifiedLine {
  raw: string;
  cleaned: string;           // ANSI codes stripped
  level: LogLevel;
  category: LogCategory;
  noiseScore: number;        // 0 = pure signal, 100 = pure noise
  timestamp?: string;
  source?: string;           // File:line if detected
  isStackTraceLine: boolean;
  isUserCodeFrame: boolean;  // True if frame should be shown (user code or diagnostic detail)
  isFirstOfGroup: boolean;   // True if this starts a new stack trace group
  isAnsiRed: boolean;        // True if the raw line contains ANSI red color codes
  framework?: string;        // Which framework produced this line
  lineNumber: number;        // Global line counter
  terminalName: string;
  receivedAt: number;        // Date.now()
}

// ---------------------------------------------------------------------------
// Pattern banks
// ---------------------------------------------------------------------------

// Error-level patterns
const ERROR_PATTERNS: RegExp[] = [
  /\b(ERROR|FATAL|CRITICAL|PANIC)\b/i,
  /\b(Error|Exception|TypeError|ReferenceError|SyntaxError|RangeError)\b:/,
  /\bUnhandled\s+(rejection|exception|error)\b/i,
  /\bERR[!_]/,
  /\bFAILED\b/i,
  /\bSegmentation fault\b/i,
  /\bOOM\b|Out of memory/i,
  /\bkilled\b/i,
  /\bAborted\b/,
  /npm ERR!/,
  /\berror TS\d+/,                      // TypeScript errors
  /\bCompilation failed\b/i,
  /\bBuild (FAIL(ED|URE))\b/i,
  /\b[Ee]xited with code [^0]\d*/,      // Non-zero exit codes
  /\bProcess exited with code [^0]\d*/i, // Process exit codes
  /Cannot (find|read|resolve|GET)\b/i,
  /\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b/,
  /\brejected\b.*\bpromise\b/i,
  /\bFailed to compile\b/i,
];

// Warning-level patterns
const WARN_PATTERNS: RegExp[] = [
  /\b(WARN|WARNING)\b/i,
  /\bDeprecated\b|\bDeprecation\b/i,
  /\bexperimental\b/i,
  /\bvulnerabilit(y|ies)\b/i,
  /npm WARN/,
  /\bCaution\b/i,
  /\bNotice\b:/i,
];

// User console output patterns
const USER_CONSOLE_PATTERNS: RegExp[] = [
  /^>\s/,                                // Common prefix for user output
  /^\s*console\.(log|info|warn|error|debug|table|dir)\b/,
  /^(LOG|INFO)\s*:\s/,
  /^\[app\]/i,
  /^---\s*(?:DEBUG|LOG|OUTPUT)\s*---/i,
  /^print\(/,                            // Python print
  /^puts\s/,                             // Ruby puts
  /^fmt\.Print/,                         // Go fmt
  /^System\.out\.print/,                 // Java
];

// Server status patterns
const STATUS_PATTERNS: RegExp[] = [
  /\blistening\s+on\s+(port\s+)?\d+/i,
  /\bserver\s+(started|running|ready)\b/i,
  /\bstarted\s+in\s+\d+/i,
  /\bready\s+in\s+\d+/i,
  /\bcompiled\s+successfully\b/i,
  /\bbuild\s+(succeeded|complete|successful)\b/i,
  /\bwatching\s+for\s+(file\s+)?changes\b/i,
  /\bconnected\s+to\s+(database|db|redis|mongo)/i,
  /\bApplication\s+is\s+running\b/i,
  /webpack\s+compiled\s+(successfully|with)/i,
  /\bHot Module Replacement\b/i,
  /\bHMR\b.*\bupdate\b/i,
];

// Stack trace line patterns
const STACK_TRACE_PATTERNS: RegExp[] = [
  /^\s+at\s+/,                           // JavaScript / Node.js
  /^\s+at\s+\S+\s+\(.*:\d+:\d+\)/,     // JS with file:line:col
  /^\s+File\s+".*",\s+line\s+\d+/,      // Python
  /^\s+from\s+.*:\d+:in\s+/,            // Ruby
  /^\s+at\s+\w+\.\w+\(.*\.java:\d+\)/, // Java
  /^\s+at\s+\w+\.\w+\(.*\.cs:\d+\)/,   // C#
  /^\s+goroutine\s+\d+/,                // Go
  /^\s+\S+\.go:\d+/,                    // Go file references
  /^\s+\|\s+\d+:/,                            // Rust backtrace
  /^\s+\d+:\s+0x[0-9a-f]+\s+-\s+/,     // Generic backtrace
  /Caused by:/i,
  /^\s+\.\.\.\s+\d+\s+more$/,           // Java "... N more"
  // javac compiler diagnostics (Maven compilation errors)
  /^\s+(symbol|location)\s*:/,          // "  symbol:   class Foo"
  /^\[ERROR\]\s+(symbol|location)\s*:/, // "[ERROR]   symbol:   class Foo"
];

// Build-tool boilerplate patterns — lines that should be downgraded from ERROR even though
// they carry an [ERROR] or [INFO] prefix containing the word "error". Checked BEFORE
// ERROR_PATTERNS in detectLevel() to prevent false elevation.
const BUILD_TOOL_BOILERPLATE_PATTERNS: RegExp[] = [
  /^\[ERROR\]\s*$/,                                                // Empty [ERROR] line
  /^\[ERROR\]\s*-+\s*$/,                                          // [ERROR] ---- separator
  /^\[ERROR\]\s*->\s*\[Help \d+\]/,                               // Maven -> [Help 1]
  /^\[ERROR\]\s*(To see the full stack trace|Re-run Maven)/i,     // Maven re-run hints
  /^\[ERROR\]\s*For more information about the errors/i,          // Maven help suggestion
  /^\[ERROR\]\s*\[Help \d+\]\s*https?:\/\//,                     // Maven help URLs
  /^\[INFO\]\s+\d+\s+errors?\b/i,                                 // Maven "[INFO] 1 error"
  /^\[ERROR\]\s+COMPILATION ERROR\s*:/i,                          // Maven section header (not red)
];

// Framework banner / noise patterns (high noise score)
const FRAMEWORK_NOISE_PATTERNS: RegExp[] = [
  // Spring Boot
  /^\s*\.\s+____\s+_/,                   // Spring Boot ASCII banner
  /^\s*\|__|_\)_\)/,
  /:: Spring Boot ::/,
  // Webpack / bundler noise
  /^(asset|chunk)\s+\S+\s+[\d.]+\s+(Ki|Mi|Gi)?B/i,
  /^modules by path/,
  /^orphan modules/,
  /^runtime modules/,
  /^cacheable modules/,
  /^webpack\s+\d+\.\d+\.\d+\s+compiled/,
  /^\s+\d+ modules$/,
  // npm/yarn install output
  /^(added|removed|changed)\s+\d+\s+package/,
  /^(up to date|audited)\s+\d+\s+package/,
  /^found\s+\d+\s+vulnerabilit/,
  // Docker build
  /^(Step|--->) [0-9a-f]{12}/i,
  /^Removing intermediate container/,
  /^Successfully (built|tagged)/,
  // General separators
  /^[=\-_*]{10,}$/,
  /^[\s]*$/,
  /^\s+$/,
  // ESLint / lint output headers
  /^✖\s+\d+\s+problem/,
  /^\d+:\d+\s+(error|warning)\s/,
  // Vite / esbuild
  /^  ➜  (Local|Network):/,
  /^  VITE v\d/,
  // Next.js
  /^  ▲ Next\.js/,
  /^  - (Local|Network):/i,
  // Create React App
  /^Compiled (successfully|with warnings)/,
  /^You can now view/,
  // Maven / build-tool boilerplate (mirrors BUILD_TOOL_BOILERPLATE_PATTERNS for scoring)
  /^\[ERROR\]\s*$/,
  /^\[ERROR\]\s*-+\s*$/,
  /^\[ERROR\]\s*->\s*\[Help \d+\]/,
  /^\[ERROR\]\s*(To see the full stack trace|Re-run Maven)/i,
  /^\[ERROR\]\s*For more information about the errors/i,
  /^\[ERROR\]\s*\[Help \d+\]\s*https?:\/\//,
  /^\[INFO\]\s+\d+\s+errors?\b/i,
  /^\[ERROR\]\s+COMPILATION ERROR\s*:/i,
];

// Timestamp patterns to extract
const TIMESTAMP_REGEX = /\b(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b|\b(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/;

// Source file:line patterns
const SOURCE_FILE_REGEX = /(?:at\s+)?(?:\()?([^\s()]+\.(js|ts|jsx|tsx|py|rb|java|go|rs|cs|cpp|c|php)):(\d+)(?::(\d+))?(?:\))?/;
const PYTHON_SOURCE_REGEX = /File\s+"([^"]+\.py)",\s+line\s+(\d+)/;
// Maven/javac format: File.java:[line,col]
const MAVEN_SOURCE_REGEX = /([^\s()]+\.java):\[(\d+),(\d+)\]/;

// ANSI escape code stripper
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[@-~]/g;

// Detects ANSI foreground red (31) or bright red (91) — the terminal is displaying this line in red
const ANSI_RED_REGEX = /\x1b\[(?:\d+;)*(?:31|91)(?:m|;)/;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export class LogClassifier {
  private lineCounter = 0;
  private customNoisePatterns: RegExp[] = [];
  private customSignalPatterns: RegExp[] = [];
  private inStackTraceByTerminal: Map<string, boolean> = new Map();

  private isInternalPath(source: string): boolean {
    return /node_modules|node:internal|site-packages|Python\.framework|\.pyc|jdk\.internal|sun\.reflect|com\.sun\./i.test(source);
  }

  setCustomPatterns(noise: string[], signal: string[]): void {
    this.customNoisePatterns = noise
      .map(p => { try { return new RegExp(p, 'i'); } catch { return null; } })
      .filter((r): r is RegExp => r !== null);
    this.customSignalPatterns = signal
      .map(p => { try { return new RegExp(p, 'i'); } catch { return null; } })
      .filter((r): r is RegExp => r !== null);
  }

  classify(raw: string, terminalName: string): ClassifiedLine {
    this.lineCounter++;
    const isAnsiRed = ANSI_RED_REGEX.test(raw);
    const cleaned = raw.replace(ANSI_REGEX, '').trimEnd();

    // Extract metadata
    const timestampMatch = cleaned.match(TIMESTAMP_REGEX);
    const sourceMatch = cleaned.match(SOURCE_FILE_REGEX);
    const pythonSourceMatch = !sourceMatch ? cleaned.match(PYTHON_SOURCE_REGEX) : null;
    const mavenSourceMatch = !sourceMatch && !pythonSourceMatch ? cleaned.match(MAVEN_SOURCE_REGEX) : null;

    // Classify
    const level = this.detectLevel(cleaned);
    const category = this.detectCategory(cleaned, level, terminalName);
    const noiseScore = this.computeNoiseScore(cleaned, level, category);

    const isStackTraceLine = category === LogCategory.STACK_TRACE;
    const wasInTrace = this.inStackTraceByTerminal.get(terminalName) || false;
    const isFirstOfGroup = isStackTraceLine && !wasInTrace;

    // Track stack trace state per terminal so concurrent terminals don't bleed into each other
    if (isStackTraceLine) {
      this.inStackTraceByTerminal.set(terminalName, true);
    } else if (wasInTrace) {
      this.inStackTraceByTerminal.set(terminalName, false);
    }

    const source = sourceMatch
      ? `${sourceMatch[1]}:${sourceMatch[3]}${sourceMatch[4] ? ':' + sourceMatch[4] : ''}`
      : pythonSourceMatch
        ? `${pythonSourceMatch[1]}:${pythonSourceMatch[2]}`
        : mavenSourceMatch
          ? `${mavenSourceMatch[1]}:${mavenSourceMatch[2]}:${mavenSourceMatch[3]}`
          : undefined;

    const isUserCodeFrame = isStackTraceLine && (
      // Diagnostic details (symbol:, location:, Caused by:, "... N more") — always relevant
      /^\s*(Caused by:|symbol\s*:|location\s*:|\.{3}\s*\d+\s+more)/i.test(cleaned) ||
      /^\[ERROR\]\s*(symbol|location)\s*:/i.test(cleaned) ||
      // Frame has a resolvable user-code source (not framework internals)
      (source != null && !this.isInternalPath(source)) ||
      // Non-"at" stack patterns without source (Python File:, Go, Rust) — show by default
      (!source && !/^\s+at\s+/.test(cleaned))
    );

    return {
      raw,
      cleaned,
      level,
      category,
      noiseScore,
      timestamp: timestampMatch ? (timestampMatch[1] || timestampMatch[2]) : undefined,
      source,
      isStackTraceLine,
      isUserCodeFrame,
      isFirstOfGroup,
      isAnsiRed,
      lineNumber: this.lineCounter,
      terminalName,
      receivedAt: Date.now(),
    };
  }

  private detectLevel(line: string): LogLevel {
    if (!line.trim()) { return LogLevel.UNKNOWN; }

    // Custom signal patterns always get USER level (highest priority)
    if (this.customSignalPatterns.some(p => p.test(line))) { return LogLevel.USER; }

    // Build-tool boilerplate — downgrade before ERROR_PATTERNS fires on [ERROR] prefix
    if (BUILD_TOOL_BOILERPLATE_PATTERNS.some(p => p.test(line))) { return LogLevel.UNKNOWN; }

    // Error check
    if (ERROR_PATTERNS.some(p => p.test(line))) { return LogLevel.ERROR; }

    // Stack trace lines inherit ERROR
    if (STACK_TRACE_PATTERNS.some(p => p.test(line))) { return LogLevel.ERROR; }

    // Warning check
    if (WARN_PATTERNS.some(p => p.test(line))) { return LogLevel.WARN; }

    // User console output
    if (USER_CONSOLE_PATTERNS.some(p => p.test(line))) { return LogLevel.USER; }

    // Server status
    if (STATUS_PATTERNS.some(p => p.test(line))) { return LogLevel.STATUS; }

    // Info-level markers
    if (/\bINFO\b/i.test(line)) { return LogLevel.INFO; }

    // Debug-level markers
    if (/\bDEBUG\b/i.test(line) || /\bTRACE\b/i.test(line)) { return LogLevel.DEBUG; }

    return LogLevel.UNKNOWN;
  }

  private detectCategory(line: string, level: LogLevel, _terminalName: string): LogCategory {
    if (!line.trim()) { return LogCategory.BLANK_OR_SEPARATOR; }
    if (/^[=\-_*~]{5,}$/.test(line.trim())) { return LogCategory.BLANK_OR_SEPARATOR; }

    if (STACK_TRACE_PATTERNS.some(p => p.test(line))) { return LogCategory.STACK_TRACE; }
    if (level === LogLevel.ERROR) { return LogCategory.ERROR_MESSAGE; }
    if (level === LogLevel.WARN) { return LogCategory.WARNING; }
    if (level === LogLevel.USER) { return LogCategory.USER_CONSOLE; }
    if (level === LogLevel.STATUS) { return LogCategory.SERVER_STATUS; }

    if (FRAMEWORK_NOISE_PATTERNS.some(p => p.test(line))) { return LogCategory.FRAMEWORK_NOISE; }
    if (this.customNoisePatterns.some(p => p.test(line))) { return LogCategory.FRAMEWORK_NOISE; }

    if (level === LogLevel.DEBUG) { return LogCategory.DEPENDENCY_LOG; }

    return LogCategory.UNKNOWN;
  }

  private computeNoiseScore(line: string, level: LogLevel, category: LogCategory): number {
    let score = 50; // Default baseline

    // Level-based scoring
    switch (level) {
      case LogLevel.ERROR:  score = 0;  break;
      case LogLevel.USER:   score = 0;  break;
      case LogLevel.WARN:   score = 15; break;
      case LogLevel.STATUS: score = 20; break;
      case LogLevel.INFO:   score = 40; break;
      case LogLevel.DEBUG:  score = 70; break;
      case LogLevel.TRACE:  score = 85; break;
    }

    // Category overrides
    switch (category) {
      case LogCategory.STACK_TRACE:      score = Math.min(score, 10); break;
      case LogCategory.USER_CONSOLE:     score = 0;  break;
      case LogCategory.ERROR_MESSAGE:    score = 0;  break;
      case LogCategory.SERVER_STATUS:    score = 15; break;
      case LogCategory.FRAMEWORK_BANNER: score = 90; break;
      case LogCategory.FRAMEWORK_NOISE:  score = 85; break;
      case LogCategory.BLANK_OR_SEPARATOR: score = 95; break;
    }

    // Adjustments
    if (!line.trim()) { score = 100; }
    if (line.length > 500) { score = Math.max(score, 60); } // Very long lines are often noise
    if (this.customSignalPatterns.some(p => p.test(line))) { score = 0; }
    if (this.customNoisePatterns.some(p => p.test(line))) { score = 95; }

    return Math.max(0, Math.min(100, score));
  }

  reset(): void {
    this.lineCounter = 0;
    this.inStackTraceByTerminal.clear();
  }
}
