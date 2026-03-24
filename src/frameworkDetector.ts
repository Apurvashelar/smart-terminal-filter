/**
 * Framework Detector — identifies what stack the user is running
 * and provides framework-specific noise/signal patterns.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FrameworkProfile {
  name: string;
  displayName: string;
  noisePatterns: RegExp[];
  signalPatterns: RegExp[];
  bannerLines: number;   // How many leading lines to suppress as startup banner
}

const PROFILES: Record<string, FrameworkProfile> = {
  nextjs: {
    name: 'nextjs',
    displayName: 'Next.js',
    noisePatterns: [
      /^  ▲ Next\.js/,
      /^  - (Local|Network):/,
      /^  - Experiments:/,
      /^  ✓ Ready in/,
      /Compiling\s+\//,
      /^  ○ Compiling/,
      /^  ✓ Compiled/,
      /^\s+\d+\s+modules\s+transformed/,
      /GET\s+\/_next\/(static|data)/,
    ],
    signalPatterns: [
      /^  ✕/,    // Next.js error marker
      /^Error:/,
      /\bFailed to compile\b/,
    ],
    bannerLines: 4,
  },

  react: {
    name: 'react',
    displayName: 'React (CRA / Vite)',
    noisePatterns: [
      /^Compiled (successfully|with warnings)/,
      /^You can now view/,
      /^  Local:/,
      /^  On Your Network:/,
      /^Note that the development build/,
      /^webpack compiled/,
      /^  VITE v\d/,
      /^  ➜  (Local|Network):/,
      /^  ➜  press h/,
      /^asset \S+\.\S+\s+[\d.]+/,
      /^orphan modules/,
      /^runtime modules/,
      /^cacheable modules/,
    ],
    signalPatterns: [
      /^Failed to compile/,
      /^Module not found/,
      /^SyntaxError/,
    ],
    bannerLines: 5,
  },

  express: {
    name: 'express',
    displayName: 'Express / Node.js',
    noisePatterns: [
      /^(GET|POST|PUT|DELETE|PATCH|OPTIONS)\s+\/\S*\s+\d{3}\s+[\d.]+\s*ms/,  // Morgan logs
      /^::1\s+-\s+-\s+\[/,           // Common log format
      /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\s+-\s/,
    ],
    signalPatterns: [
      /listening on port/i,
      /\bUnhandledPromiseRejection\b/,
      /\bERR_HTTP_HEADERS_SENT\b/,
    ],
    bannerLines: 0,
  },

  django: {
    name: 'django',
    displayName: 'Django',
    noisePatterns: [
      /^Watching for file changes/,
      /^Performing system checks/,
      /^System check identified no issues/,
      /^\s+\* Debugger is active!/,
      /^\s+\* Debugger PIN:/,
      /^"(GET|POST|PUT|DELETE)\s+\/\S*\s+HTTP/,  // Django request log
      /^Not Found:\s+\//,
      /^Quit the server with/,
    ],
    signalPatterns: [
      /^Traceback \(most recent call last\)/,
      /^(django\.core\.exceptions|ImproperlyConfigured)/,
      /^CommandError/,
    ],
    bannerLines: 3,
  },

  springboot: {
    name: 'springboot',
    displayName: 'Spring Boot',
    noisePatterns: [
      /^\s*\.\s+____\s+_/,
      /^\s*\|__|_\)_\)/,
      /:: Spring Boot ::/,
      /^.*o\.s\.b\.w\.embedded\.tomcat\.TomcatWebServer\b/,
      /^.*o\.s\.web\.servlet\.DispatcherServlet\b.*initializ/,
      /^.*o\.hibernate\./,
      /^.*HikariPool.*-.*Start/,
      /^.*Tomcat started on port/,
    ],
    signalPatterns: [
      /^.*APPLICATION FAILED TO START/,
      /^.*BeanCreationException/,
      /^.*BindException/,
    ],
    bannerLines: 8,
  },

  rails: {
    name: 'rails',
    displayName: 'Ruby on Rails',
    noisePatterns: [
      /^=> Booting (Puma|WEBrick)/,
      /^=> Rails \d+\.\d+/,
      /^=> Run `rails/,
      /^\* (Listening|Environment|PID)/,
      /^Started (GET|POST|PUT|DELETE|PATCH)\s+"/,
      /^Processing by \w+#\w+ as/,
      /^  Rendering /,
      /^  Rendered /,
      /^Completed \d{3}/,
      /^  Parameters:/,
    ],
    signalPatterns: [
      /^(ActionController|ActiveRecord|NoMethodError|NameError)/,
      /^Routing Error/,
    ],
    bannerLines: 4,
  },

  docker: {
    name: 'docker',
    displayName: 'Docker',
    noisePatterns: [
      /^(Step|--->) [0-9a-f]/i,
      /^Removing intermediate container/,
      /^Successfully (built|tagged)/,
      /^Sending build context/,
      /^DEPRECATED: The legacy builder/,
      /^\s+---> [0-9a-f]{12}/,
      /^#\d+\s+(CACHED\s+)?\[/,
    ],
    signalPatterns: [
      /^ERROR \[/,
      /^failed to solve/,
      /^error during connect/,
    ],
    bannerLines: 0,
  },

  go: {
    name: 'go',
    displayName: 'Go',
    noisePatterns: [
      /^go: downloading\s/,
      /^go: finding\s/,
    ],
    signalPatterns: [
      /^\.\/\S+\.go:\d+:\d+:/,    // Go compiler errors
      /^panic:/,
      /^goroutine \d+/,
      /^fatal error:/,
    ],
    bannerLines: 0,
  },
};

export class FrameworkDetector {
  /**
   * Detect frameworks from workspace files.
   */
  detect(workspaceRoot: string): FrameworkProfile[] {
    const detected: FrameworkProfile[] = [];

    const fileExists = (f: string) => {
      try { return fs.existsSync(path.join(workspaceRoot, f)); }
      catch { return false; }
    };

    const packageJsonContent = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')); }
      catch { return null; }
    })();

    const deps = packageJsonContent
      ? { ...packageJsonContent.dependencies, ...packageJsonContent.devDependencies }
      : {};

    // Next.js
    if (deps['next'] || fileExists('next.config.js') || fileExists('next.config.mjs') || fileExists('next.config.ts')) {
      detected.push(PROFILES.nextjs);
    }
    // React (CRA or Vite)
    else if (deps['react-scripts'] || deps['react'] || deps['vite']) {
      detected.push(PROFILES.react);
    }

    // Express
    if (deps['express'] || deps['fastify'] || deps['hapi'] || deps['koa']) {
      detected.push(PROFILES.express);
    }

    // Django
    if (fileExists('manage.py') && (fileExists('settings.py') || fileExists('wsgi.py'))) {
      detected.push(PROFILES.django);
    }

    // Spring Boot
    if (fileExists('pom.xml') || fileExists('build.gradle') || fileExists('build.gradle.kts')) {
      detected.push(PROFILES.springboot);
    }

    // Rails
    if (fileExists('Gemfile') && fileExists('config/routes.rb')) {
      detected.push(PROFILES.rails);
    }

    // Docker
    if (fileExists('Dockerfile') || fileExists('docker-compose.yml') || fileExists('docker-compose.yaml') || fileExists('compose.yml')) {
      detected.push(PROFILES.docker);
    }

    // Go
    if (fileExists('go.mod')) {
      detected.push(PROFILES.go);
    }

    return detected;
  }

  /**
   * Detect framework from terminal output content (runtime detection).
   */
  detectFromOutput(line: string): FrameworkProfile | null {
    if (/▲ Next\.js/.test(line)) { return PROFILES.nextjs; }
    if (/VITE v\d/.test(line)) { return PROFILES.react; }
    if (/:: Spring Boot ::/.test(line)) { return PROFILES.springboot; }
    if (/=> Rails \d/.test(line)) { return PROFILES.rails; }
    if (/Watching for file changes.*Django/.test(line)) { return PROFILES.django; }
    if (/^#\d+\s+\[/.test(line) || /^Step \d+\/\d+/.test(line)) { return PROFILES.docker; }
    return null;
  }

  getProfile(name: string): FrameworkProfile | undefined {
    return PROFILES[name];
  }

  getAllProfiles(): FrameworkProfile[] {
    return Object.values(PROFILES);
  }
}
