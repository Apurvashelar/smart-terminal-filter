#!/usr/bin/env node

/**
 * smartlog — CLI pipe tool for terminal log filtering.
 * 
 * Works in any terminal, any IDE, any OS.
 * 
 * Usage:
 *   npm start | smartlog
 *   python manage.py runserver | smartlog
 *   docker logs -f mycontainer | smartlog
 *   go run main.go 2>&1 | smartlog
 * 
 * Options:
 *   -v, --verbosity <1-5>   Set verbosity level (default: 2)
 *   -e, --errors-only       Show only errors (shortcut for -v 1)
 *   -r, --raw               Show everything (shortcut for -v 5)
 *   -s, --summary           Print summary at end
 *   -q, --query <text>      Filter by natural language query
 *   --no-color              Disable colored output
 *   --json                  Output as JSON (one object per line)
 *   -h, --help              Show help
 */

import * as readline from 'readline';
import { LogClassifier, LogLevel, ClassifiedLine } from '../src/logClassifier';
import { FilterEngine, VerbosityLevel } from '../src/filterEngine';


// ---------------------------------------------------------------------------
// ANSI color codes
// ---------------------------------------------------------------------------
const C = {
  reset:   '\x1b[0m',
  red:     '\x1b[91m',
  yellow:  '\x1b[93m',
  cyan:    '\x1b[96m',
  green:   '\x1b[92m',
  gray:    '\x1b[90m',
  white:   '\x1b[97m',
  magenta: '\x1b[95m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  bgRed:   '\x1b[41m',
  bgYellow:'\x1b[43m',
};

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
interface CLIOptions {
  verbosity: VerbosityLevel;
  summary: boolean;
  query: string | null;
  noColor: boolean;
  json: boolean;
}

function parseArgs(args: string[]): CLIOptions {
  const opts: CLIOptions = {
    verbosity: 2 as VerbosityLevel,
    summary: false,
    query: null,
    noColor: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-v':
      case '--verbosity':
        const v = parseInt(args[++i], 10);
        if (v >= 1 && v <= 5) opts.verbosity = v as VerbosityLevel;
        break;
      case '-e':
      case '--errors-only':
        opts.verbosity = 1;
        break;
      case '-r':
      case '--raw':
        opts.verbosity = 5;
        break;
      case '-s':
      case '--summary':
        opts.summary = true;
        break;
      case '-q':
      case '--query':
        opts.query = args[++i] || null;
        break;
      case '--no-color':
        opts.noColor = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`
${C.bold}smartlog${C.reset} — AI-ready terminal log filter

${C.bold}Usage:${C.reset}
  npm start | smartlog
  python app.py | smartlog -v 3
  docker logs -f container | smartlog -e
  go run . 2>&1 | smartlog -q "database errors"

${C.bold}Options:${C.reset}
  -v, --verbosity <1-5>   Verbosity level (default: 2)
                            1 = errors + your console output only
                            2 = + warnings
                            3 = + server status
                            4 = + verbose / info
                            5 = everything (raw)
  -e, --errors-only       Shortcut for -v 1
  -r, --raw               Shortcut for -v 5
  -s, --summary           Print summary when input ends
  -q, --query <text>      Natural language filter
                            "show me database errors"
                            "slow queries over 100ms"
                            "authentication failures"
  --no-color              Disable colored output
  --json                  Output each line as JSON object
  -h, --help              Show this help

${C.bold}Verbosity levels:${C.reset}
  ${C.red}Level 1${C.reset}  Errors + your console.log/print statements
  ${C.yellow}Level 2${C.reset}  + Warnings and deprecation notices
  ${C.cyan}Level 3${C.reset}  + Server status, build results
  ${C.white}Level 4${C.reset}  + Info-level, framework logs
  ${C.gray}Level 5${C.reset}  Everything — unfiltered raw output
`);
}

// ---------------------------------------------------------------------------
// Color a line based on its level
// ---------------------------------------------------------------------------
function colorize(line: ClassifiedLine, noColor: boolean): string {
  if (noColor) return line.cleaned;

  const text = line.cleaned;
  switch (line.level) {
    case LogLevel.ERROR:
      return `${C.red}${text}${C.reset}`;
    case LogLevel.WARN:
      return `${C.yellow}${text}${C.reset}`;
    case LogLevel.USER:
      return `${C.green}${C.bold}${text}${C.reset}`;
    case LogLevel.STATUS:
      return `${C.cyan}${text}${C.reset}`;
    case LogLevel.INFO:
      return `${C.white}${text}${C.reset}`;
    case LogLevel.DEBUG:
    case LogLevel.TRACE:
      return `${C.dim}${text}${C.reset}`;
    default:
      return `${C.gray}${text}${C.reset}`;
  }
}

function levelPrefix(level: LogLevel, noColor: boolean): string {
  const labels: Record<string, string> = {
    error:   noColor ? '[ERR]' : `${C.bgRed}${C.white} ERR ${C.reset}`,
    warn:    noColor ? '[WRN]' : `${C.bgYellow}${C.white} WRN ${C.reset}`,
    user:    noColor ? '[USR]' : `${C.green}[USR]${C.reset}`,
    status:  noColor ? '[STS]' : `${C.cyan}[STS]${C.reset}`,
    info:    noColor ? '[INF]' : `${C.gray}[INF]${C.reset}`,
    debug:   noColor ? '[DBG]' : `${C.dim}[DBG]${C.reset}`,
    trace:   noColor ? '[TRC]' : `${C.dim}[TRC]${C.reset}`,
    unknown: noColor ? '[---]' : `${C.dim}[---]${C.reset}`,
  };
  return labels[level] || labels.unknown;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Check if stdin is a TTY (no piped input)
  if (process.stdin.isTTY) {
    console.error(`${C.yellow}smartlog: No piped input detected.${C.reset}`);
    console.error(`Usage: npm start | smartlog`);
    console.error(`Run smartlog --help for options.`);
    process.exit(1);
  }

  const engine = new FilterEngine(10000);
  engine.setVerbosity(opts.verbosity);

  // Print header
  if (!opts.json) {
    const levelNames = ['', 'Errors only', '+Warnings', '+Status', '+Verbose', 'Raw'];
    process.stderr.write(
      `${C.magenta}${C.bold}⚡ smartlog${C.reset} ${C.dim}v0.1.0${C.reset}` +
      ` ${C.dim}|${C.reset} verbosity: ${C.bold}${opts.verbosity}${C.reset} (${levelNames[opts.verbosity]})` +
      (opts.query ? ` ${C.dim}|${C.reset} query: ${C.cyan}"${opts.query}"${C.reset}` : '') +
      '\n'
    );
  }

  // Prepare query filter if specified
  let queryTerms: RegExp | null = null;
  if (opts.query) {
    // Pre-compute a simple regex for fast line-by-line matching
    const words = opts.query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length > 0) {
      try {
        queryTerms = new RegExp(words.join('|'), 'i');
      } catch {
        queryTerms = null;
      }
    }
  }

  // Read stdin line by line
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  let lineCount = 0;
  let shownCount = 0;

  rl.on('line', (rawLine: string) => {
    lineCount++;

    const entries = engine.processData(rawLine + '\n', 'stdin');

    for (const entry of entries) {
      if (!entry.visible) continue;

      // Apply NL query filter
      if (queryTerms && !queryTerms.test(entry.line.cleaned)) continue;

      shownCount++;

      if (opts.json) {
        // JSON output mode
        const obj = {
          line: entry.line.lineNumber,
          level: entry.line.level,
          category: entry.line.category,
          noise: entry.line.noiseScore,
          text: entry.line.cleaned,
          timestamp: entry.line.timestamp || null,
          source: entry.line.source || null,
        };
        process.stdout.write(JSON.stringify(obj) + '\n');
      } else {
        // Colored terminal output
        const prefix = levelPrefix(entry.line.level, opts.noColor);
        const content = colorize(entry.line, opts.noColor);
        process.stdout.write(`${prefix} ${content}\n`);
      }
    }
  });

  rl.on('close', async () => {
    // Print summary if requested
    if (opts.summary && !opts.json) {
      const stats = engine.getStats();
      const pctFiltered = stats.totalLines > 0
        ? Math.round((stats.noiseHidden / stats.totalLines) * 100)
        : 0;

      process.stderr.write('\n');
      process.stderr.write(`${C.magenta}${C.bold}── Summary ──${C.reset}\n`);
      process.stderr.write(`  Total lines:  ${stats.totalLines}\n`);
      process.stderr.write(`  Shown:        ${stats.visibleLines} (${pctFiltered}% noise filtered)\n`);

      if (stats.errors > 0) {
        process.stderr.write(`  ${C.red}Errors:       ${stats.errors}${C.reset}\n`);
      }
      if (stats.warnings > 0) {
        process.stderr.write(`  ${C.yellow}Warnings:     ${stats.warnings}${C.reset}\n`);
      }
      if (stats.userLogs > 0) {
        process.stderr.write(`  ${C.green}Console logs: ${stats.userLogs}${C.reset}\n`);
      }

      const frameworks = engine.getDetectedFrameworks();
      if (frameworks.length > 0) {
        process.stderr.write(`  Frameworks:   ${frameworks.join(', ')}\n`);
      }

      process.stderr.write('\n');
    }

    // Print query match summary if specified
    if (opts.query && !opts.json) {
      process.stderr.write(`${C.magenta}${C.bold}── Query: "${opts.query}" ──${C.reset}\n`);
      process.stderr.write(`  Filtered by keyword matching.\n\n`);
    }
  });
}

main().catch(err => {
  console.error(`smartlog error: ${err.message}`);
  process.exit(1);
});
