'use strict';

/**
 * ARVEX backend entry point.
 *
 *   npm start  → node server/index.js
 *   npm run dev → node --watch server/index.js
 *
 * Serves public/ statically and the JSON API documented in API.md, and runs
 * the order-completion timer every 20 seconds (unref'd, so it never keeps the
 * process alive on its own).
 */

const express = require('express');

const config = require('./config');
const db = require('./db');
const routes = require('./routes');
const referral = require('./referral');

const TICK_INTERVAL_MS = 20_000;

/** Build the Express app (used by `start()` and by the smoke test). */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(express.json({ limit: '512kb' }));
  routes.mount(app);
  return app;
}

function printBanner(port) {
  const line = '─'.repeat(62);
  const rates = db.getRates();
  const mode = config.INSECURE
    ? 'INSECURE / dev  — BOT_TOKEN is empty, initData is NOT verified (set BOT_TOKEN in production!)'
    : 'secure — initData signature verified against BOT_TOKEN';
  const root =
    config.ROOT_ADMIN_TG_ID === null
      ? 'NOT CONFIGURED (set ROOT_ADMIN_ID in .env to get an admin panel)'
      : `${config.ROOT_ADMIN_TG_ID} (configured, immutable)`;

  console.log(`\n${line}`);
  console.log(' ARVEX backend');
  console.log(line);
  console.log(`   port              : ${port}`);
  console.log(`   url               : http://127.0.0.1:${port}/`);
  console.log(`   admin panel       : http://127.0.0.1:${port}/admin`);
  console.log(`   mode              : ${mode}`);
  console.log(`   root admin        : ${root}`);
  console.log(`   database          : ${config.DATABASE_FILE}`);
  console.log(`   auto-approve      : ${autoApproveLabel()}`);
  console.log(`   referral rates    : L1 ${(rates.l1 * 100).toFixed(2)}% / L2 ${(rates.l2 * 100).toFixed(2)}% / L3 ${(rates.l3 * 100).toFixed(2)}% (enabled: ${db.referralEnabled() ? 'yes' : 'no'})`);
  console.log(`   invite bot        : @${config.INVITE_BOT_USERNAME}`);
  console.log(`   completion timer  : every ${TICK_INTERVAL_MS / 1000}s`);
  console.log(`${line}\n`);
}

function autoApproveLabel() {
  return db.autoApproveOrders() ? 'on (orders activate immediately)' : 'off (orders wait for admin approval)';
}

/**
 * Boot the server. Resolves once it is listening with
 * `{ app, server, port, timer, close }`.
 */
async function start({ port = config.PORT, host = config.HOST, intervalMs = TICK_INTERVAL_MS } = {}) {
  const app = createApp();

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.once('error', reject);
  });

  const actualPort = server.address() ? server.address().port : port;
  printBanner(actualPort);

  // complete due orders once at boot, then on the 20s timer
  const runTick = () => {
    try {
      const completed = referral.tick();
      if (completed > 0) console.log(`[arvex] tick: completed ${completed} order(s)`);
    } catch (error) {
      console.error('[arvex] tick failed:', (error && error.stack) || error);
    }
  };
  runTick();

  const timer = setInterval(runTick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  const close = () =>
    new Promise((resolve, reject) => {
      clearInterval(timer);
      server.close((error) => (error ? reject(error) : resolve()));
    });

  return { app, server, port: actualPort, timer, close };
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[arvex] failed to start:', (error && error.stack) || error);
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    console.log(`\n[arvex] ${signal} received, shutting down`);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createApp, start, TICK_INTERVAL_MS };
