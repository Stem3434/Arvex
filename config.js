'use strict';

/**
 * ARVEX configuration.
 *
 * Loads `<project root>/.env` when present (tiny hand written parser: KEY=VALUE
 * lines, blank lines and `#` comments ignored, optional quotes stripped) and
 * NEVER overrides a variable that is already set in `process.env`.
 *
 * No dotenv dependency on purpose — see API.md ("Environment (.env)").
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ENV_FILE = path.join(ROOT_DIR, '.env');

/** Parse the textual content of a .env file into a plain object. */
function parseEnv(text) {
  const out = {};
  const source = text == null ? '' : String(text);
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue; // blank line / comment
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no key, or no '=' at all
    let key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #'); // trailing inline comment
      if (comment > 0) value = value.slice(0, comment).trim();
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Read .env (if it exists) and apply it to process.env without overriding. */
function loadEnv(file = ENV_FILE) {
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // no .env — fine, defaults + real env vars are used
  }
  const vars = parseEnv(text);
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return vars;
}

loadEnv();

function str(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null ? fallback : String(raw).trim();
}

function int(name, fallback) {
  const raw = str(name, '');
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = str(name, '').toLowerCase();
  if (raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function resolveFile(p) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p);
}

const BOT_TOKEN = str('BOT_TOKEN', '');
const ROOT_ADMIN_ID = str('ROOT_ADMIN_ID', '');
const rootAdminTgId = /^\d+$/.test(ROOT_ADMIN_ID) ? Number(ROOT_ADMIN_ID) : null;
const SESSION_TTL_HOURS = int('SESSION_TTL_HOURS', 720);
const ADMIN_LOGIN = str('ADMIN_LOGIN', '');
const ADMIN_PASSWORD = str('ADMIN_PASSWORD', '');
const ADMIN_PASSWORD_SALT = str('ADMIN_PASSWORD_SALT', '');
const config = {
  ROOT_DIR,
  PUBLIC_DIR,
  ENV_FILE,
  ENV_LOADED: fs.existsSync(ENV_FILE),

  PORT: int('PORT', 3000),
  HOST: str('HOST', '0.0.0.0'),
  BOT_TOKEN,
  /** Telegram id of the immutable root admin as a string ('' when unset). */
  ROOT_ADMIN_ID: rootAdminTgId === null ? '' : String(rootAdminTgId),
  /** Same value as a safe integer, or null when unset/invalid. */
  ROOT_ADMIN_TG_ID: rootAdminTgId,
  ADMIN_LOGIN,
ADMIN_PASSWORD,
ADMIN_PASSWORD_SALT,
  DATABASE_FILE: resolveFile(str('DATABASE_FILE', './data/arvex.sqlite')),
  AUTO_APPROVE_ORDERS: bool('AUTO_APPROVE_ORDERS', true),
  INVITE_BOT_USERNAME: str('INVITE_BOT_USERNAME', 'ArvexCapitalOfficialBot')
  SESSION_TTL_HOURS: SESSION_TTL_HOURS > 0 ? SESSION_TTL_HOURS : 720,
  SESSION_TTL_MS: (SESSION_TTL_HOURS > 0 ? SESSION_TTL_HOURS : 720) * 3600 * 1000,
  /** true when no BOT_TOKEN is configured → dev mode, initData not verified. */
  INSECURE: !BOT_TOKEN,
};

module.exports = config;
