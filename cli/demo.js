#!/usr/bin/env node

/**
 * smartlog demo — Simulates real terminal output to showcase the filtering.
 *
 * Usage: node out-cli/cli/demo.js | node out-cli/cli/smartlog.js -v 2 -s
 *
 * Outputs a realistic stream of Next.js + Express logs with errors, warnings,
 * user console statements, and framework noise — line by line with realistic timing.
 */

const lines = [
  { delay: 0,    text: '' },
  { delay: 100,  text: '  ▲ Next.js 14.2.3' },
  { delay: 50,   text: '  - Local:        http://localhost:3000' },
  { delay: 50,   text: '  - Network:      http://192.168.1.42:3000' },
  { delay: 50,   text: '  - Experiments (use at your own risk):' },
  { delay: 50,   text: '     · serverActions' },
  { delay: 200,  text: '' },
  { delay: 300,  text: '  ✓ Ready in 1.8s' },
  { delay: 100,  text: '' },
  { delay: 50,   text: '[nodemon] 3.1.0' },
  { delay: 30,   text: '[nodemon] watching path(s): src/**/*' },
  { delay: 30,   text: '[nodemon] watching extensions: ts,json' },
  { delay: 30,   text: '[nodemon] starting `ts-node src/server.ts`' },
  { delay: 500,  text: '' },
  { delay: 200,  text: '2024-03-22T10:15:33.100Z INFO  [app] Initializing middleware...' },
  { delay: 100,  text: '2024-03-22T10:15:33.120Z DEBUG [cors] CORS enabled for origins: *' },
  { delay: 80,   text: '2024-03-22T10:15:33.130Z DEBUG [body-parser] JSON limit: 10mb' },
  { delay: 80,   text: '2024-03-22T10:15:33.140Z DEBUG [session] Redis session store connecting...' },
  { delay: 300,  text: '2024-03-22T10:15:33.421Z INFO  [app] Server listening on port 3001' },
  { delay: 100,  text: '2024-03-22T10:15:33.422Z INFO  [db] Connected to PostgreSQL: postgres://localhost:5432/myapp' },
  { delay: 100,  text: '2024-03-22T10:15:33.500Z DEBUG [hikari] HikariPool-1 - Starting...' },
  { delay: 50,   text: '2024-03-22T10:15:33.501Z DEBUG [hikari] HikariPool-1 - Pool stats (total=10, active=0, idle=10, waiting=0)' },
  { delay: 50,   text: '2024-03-22T10:15:33.510Z DEBUG [redis] Connected to Redis at 127.0.0.1:6379' },
  { delay: 200,  text: '' },
  { delay: 100,  text: 'webpack compiled successfully in 1234ms' },
  { delay: 50,   text: 'asset main.js 245 KiB [emitted] (name: main)' },
  { delay: 30,   text: 'asset vendor.js 1.2 MiB [emitted] (name: vendor)' },
  { delay: 30,   text: 'asset styles.css 89 KiB [emitted] (name: styles)' },
  { delay: 30,   text: 'orphan modules 12 KiB [orphan] 4 modules' },
  { delay: 30,   text: 'runtime modules 2.5 KiB 3 modules' },
  { delay: 30,   text: 'cacheable modules 890 KiB' },
  { delay: 30,   text: '  128 modules' },
  { delay: 200,  text: '' },
  // User traffic starts
  { delay: 500,  text: 'console.log("App initialized, waiting for requests...")' },
  { delay: 1000, text: '2024-03-22T10:15:35.100Z INFO  GET /api/health 200 2ms' },
  { delay: 200,  text: '2024-03-22T10:15:35.300Z INFO  GET /api/users 200 15ms' },
  { delay: 300,  text: 'console.log("User loaded: alice@example.com, role=admin")' },
  { delay: 200,  text: '2024-03-22T10:15:35.500Z INFO  POST /api/orders 201 45ms' },
  { delay: 100,  text: '> Order created: { id: 1042, user: "alice", total: 299.99 }' },
  { delay: 300,  text: '2024-03-22T10:15:35.800Z INFO  GET /_next/static/chunks/app/page.js 200 3ms' },
  { delay: 50,   text: '2024-03-22T10:15:35.850Z INFO  GET /_next/data/build-abc123/index.json 200 2ms' },
  { delay: 500,  text: '' },
  // Warning
  { delay: 200,  text: 'WARNING: Deprecated API usage in middleware/auth.js — req.user.isAdmin() will be removed in v3.0' },
  { delay: 300,  text: 'npm WARN deprecated inflight@1.0.6: This module is not supported and leaks memory' },
  { delay: 200,  text: '' },
  // More traffic
  { delay: 400,  text: '2024-03-22T10:15:37.100Z INFO  GET /api/products?category=electronics 200 125ms' },
  { delay: 200,  text: '2024-03-22T10:15:37.300Z INFO  GET /api/cart 200 8ms' },
  { delay: 300,  text: 'console.log("Payment processing:", { orderId: 1042, amount: 299.99, gateway: "stripe" })' },
  { delay: 200,  text: '' },
  // ERROR — the main event
  { delay: 500,  text: 'TypeError: Cannot read properties of undefined (reading \'email\')' },
  { delay: 30,   text: '    at UserService.getProfile (/app/src/services/user.ts:47:23)' },
  { delay: 20,   text: '    at async OrderController.create (/app/src/controllers/order.ts:89:15)' },
  { delay: 20,   text: '    at async /app/node_modules/express/lib/router/layer.js:95:5' },
  { delay: 20,   text: '    at async /app/node_modules/express/lib/router/route.js:144:3' },
  { delay: 20,   text: '    at async Function.process_params (/app/node_modules/express/lib/router/index.js:346:12)' },
  { delay: 200,  text: '' },
  // Recovery attempt
  { delay: 300,  text: '2024-03-22T10:15:38.800Z INFO  [app] Retrying failed request for user bob@example.com...' },
  { delay: 500,  text: '' },
  // Another error
  { delay: 200,  text: 'Error: ECONNREFUSED — Connection refused to Redis at 127.0.0.1:6379' },
  { delay: 100,  text: '2024-03-22T10:15:39.500Z INFO  [redis] Reconnecting in 5s (attempt 1/10)...' },
  { delay: 200,  text: '' },
  // Critical user error
  { delay: 300,  text: 'console.error("CRITICAL: Payment gateway timeout after 30000ms — order 1042 stuck in pending")' },
  { delay: 200,  text: '' },
  // Recovery
  { delay: 1000, text: '2024-03-22T10:15:42.100Z INFO  [redis] Reconnected to Redis successfully' },
  { delay: 200,  text: 'console.log("Order 1042 recovered — payment confirmed via webhook fallback")' },
  { delay: 300,  text: '' },
  { delay: 200,  text: 'Compiled successfully!' },
  { delay: 100,  text: 'You can now view my-app in the browser.' },
  { delay: 50,   text: '  Local:            http://localhost:3000' },
  { delay: 50,   text: '  On Your Network:  http://192.168.1.42:3000' },
];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  for (const line of lines) {
    await sleep(line.delay);
    process.stdout.write(line.text + '\n');
  }
}

main();
