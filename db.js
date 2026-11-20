'use strict';

/**
 * ARVEX data layer — built-in `node:sqlite` (no ORM, no native modules).
 *
 * Opens the SQLite file (creating the parent directory), applies the PRAGMAs
 * from API.md, creates every table when missing, seeds the 4 plans and the
 * settings rows with `INSERT OR IGNORE` (so admin edits survive restarts) and
 * makes sure ROOT_ADMIN_ID exists in `admins` with `is_root = 1`.
 *
 * Prepared statements are memoised by SQL text and exported for the routes.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');

/* -------------------------------------------------------------------------- */
/* money + time helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * THE single money helper: round to 2 decimals, half away from zero,
 * tolerant to binary floating point noise (1.005 → 1.01, 27*0.07 → 1.89).
 */
function round2(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const base = Number(n.toFixed(9)); // kill representation noise first
  const scaled = Number((base * 100).toFixed(6));
  const sign = scaled < 0 ? -1 : 1;
  const rounded = sign * Math.round(Math.abs(scaled));
  return rounded === 0 ? 0 : rounded / 100;
}

/** ISO-8601 UTC string, the canonical timestamp format of this app. */
function nowIso(date = new Date()) {
  return date.toISOString();
}

/** ISO-8601 UTC string `ms` milliseconds in the future (may be negative). */
function isoIn(ms, date = new Date()) {
  return new Date(date.getTime() + Number(ms || 0)).toISOString();
}

/* -------------------------------------------------------------------------- */
/* schema                                                                      */
/* -------------------------------------------------------------------------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  tg_id        INTEGER PRIMARY KEY,
  code         TEXT    NOT NULL UNIQUE,
  referrer_id  INTEGER REFERENCES users(tg_id),
  first_name   TEXT,
  username     TEXT,
  balance      REAL    NOT NULL DEFAULT 0,
  ref_balance  REAL    NOT NULL DEFAULT 0,
  total_profit REAL    NOT NULL DEFAULT 0,
  total_ref    REAL    NOT NULL DEFAULT 0,
  banned       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL,
  consent      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  tg_id      INTEGER NOT NULL REFERENCES users(tg_id),
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  tg_id      INTEGER PRIMARY KEY,
  added_by   INTEGER,
  is_root    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  min_amount   REAL    NOT NULL,
  max_amount   REAL    NOT NULL,
  rate_lo      REAL    NOT NULL,
  rate_hi      REAL    NOT NULL,
  period_hours INTEGER NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(tg_id),
  plan_id      TEXT    NOT NULL REFERENCES plans(id),
  amount       REAL    NOT NULL,
  rate         REAL    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_at   TEXT    NOT NULL,
  activated_at TEXT,
  completes_at TEXT,
  profit       REAL,
  completed_at TEXT,
  reviewed_by  INTEGER,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS accruals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(tg_id),
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  level        INTEGER NOT NULL,
  from_user_id INTEGER NOT NULL REFERENCES users(tg_id),
  base_profit  REAL    NOT NULL,
  rate         REAL    NOT NULL,
  amount       REAL    NOT NULL,
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(tg_id),
  amount      REAL    NOT NULL,
  source      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  reviewed_at TEXT,
  reviewed_by INTEGER,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_referrer   ON users(referrer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tg_id   ON sessions(tg_id);
CREATE INDEX IF NOT EXISTS idx_orders_user      ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status, completes_at);
CREATE INDEX IF NOT EXISTS idx_accruals_user    ON accruals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_accruals_order   ON accruals(order_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, created_at);
`;

/** Seed plans — API.md "Seed plans". */
const PLAN_SEED = [
  ['start', 'START', 25, 1500, 0.25, 0.27, 24, 1, 1],
  ['standard', 'STANDARD', 1501, 5000, 0.28, 0.3, 24, 1, 2],
  ['advanced', 'ADVANCED', 5001, 10000, 0.31, 0.34, 72, 1, 3],
  ['vip', 'VIP', 10001, 50000, 0.35, 0.37, 72, 1, 4],
];

/** Seed settings — API.md "Seed settings" (auto_approve_orders comes from .env). */
const SETTINGS_SEED = [
  ['rate_l1', '0.10'],
  ['rate_l2', '0.07'],
  ['rate_l3', '0.05'],
  ['referral_enabled', '1'],
];

/* -------------------------------------------------------------------------- */
/* open + migrate + seed                                                       */
/* -------------------------------------------------------------------------- */

function openDatabase(file = config.DATABASE_FILE) {
  const dir = path.dirname(file);
  if (dir && dir !== file) fs.mkdirSync(dir, { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA foreign_keys = ON;');
  handle.exec('PRAGMA busy_timeout = 5000;');
  handle.exec(SCHEMA);
  return handle;
}

const db = openDatabase();

/* -------------------------------------------------------------------------- */
/* prepared statement helpers                                                  */
/* -------------------------------------------------------------------------- */

const statementCache = new Map();

/** Prepare (and memoise) a statement. */
function prep(sql) {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

/**
 * Cheap guard: our SQL uses only positional `?` placeholders, so a mismatch
 * between placeholders and arguments is always a bug (SQLite itself reports it
 * as the very confusing "column index out of range").
 */
function checkArity(sql, params) {
  const wanted = (String(sql).match(/\?/g) || []).length;
  if (params.length !== wanted) {
    throw new Error(
      `statement arity mismatch: ${wanted} placeholder(s), ${params.length} argument(s) → ${String(sql).replace(/\s+/g, ' ').trim()}`,
    );
  }
}

/** `select ...` → one row (or undefined). */
function get(sql, ...params) {
  checkArity(sql, params);
  return prep(sql).get(...params);
}

/** `select ...` → all rows. */
function all(sql, ...params) {
  checkArity(sql, params);
  return prep(sql).all(...params);
}

/** `insert/update/delete` → `{ changes, lastInsertRowid }`. */
function run(sql, ...params) {
  checkArity(sql, params);
  return prep(sql).run(...params);
}

/** Run `fn` inside a transaction; rolls back on throw. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function seed() {
  const insertPlan = prep(
    `INSERT OR IGNORE INTO plans
       (id, name, min_amount, max_amount, rate_lo, rate_hi, period_hours, enabled, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const plan of PLAN_SEED) insertPlan.run(...plan);

  const insertSetting = prep('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of SETTINGS_SEED) insertSetting.run(key, value);

  // ROOT_ADMIN_ID is always an admin with is_root = 1 (re-asserted on every boot).
  if (config.ROOT_ADMIN_TG_ID !== null) {
    ensureUser({
      tg_id: config.ROOT_ADMIN_TG_ID,
      first_name: 'Root Admin',
      username: null,
    });
    run(
      `INSERT INTO admins (tg_id, added_by, is_root, created_at) VALUES (?, NULL, 1, ?)
       ON CONFLICT(tg_id) DO UPDATE SET is_root = 1`,
      config.ROOT_ADMIN_TG_ID,
      nowIso(),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* users                                                                       */
/* -------------------------------------------------------------------------- */

const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // no look-alikes

/** Generate a unique referral code matching `[a-z0-9]{6,10}`. */
function generateCode(length = 8) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    const size = Math.min(10, Math.max(6, length));
    for (let i = 0; i < size; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!get('SELECT tg_id FROM users WHERE code = ?', code)) return code;
  }
  // extremely unlikely fallback: still `[a-z0-9]{6,10}`
  return `c${Date.now().toString(36).slice(-8)}`.slice(0, 10);
}

function getUser(tgId) {
  if (tgId === null || tgId === undefined) return undefined;
  return get('SELECT * FROM users WHERE tg_id = ?', Number(tgId));
}

function getUserByCode(code) {
  if (!code) return undefined;
  return get('SELECT * FROM users WHERE code = ?', String(code).toLowerCase());
}

/**
 * Insert a user when missing (auto-generating a referral code) and refresh the
 * profile fields + last_seen_at. Never touches balances or `banned`.
 */
function ensureUser({ tg_id, first_name = null, username = null, referrer_id = null }) {
  const id = Number(tg_id);
  const now = nowIso();
  const existing = getUser(id);
  if (existing) {
    run(
      'UPDATE users SET first_name = ?, username = ?, last_seen_at = ? WHERE tg_id = ?',
      first_name === null ? existing.first_name : first_name,
      username === undefined || username === null ? existing.username : username,
      now,
      id,
    );
    return getUser(id);
  }
  run(
    `INSERT INTO users (tg_id, code, referrer_id, first_name, username, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    generateCode(),
    referrer_id === null || referrer_id === undefined ? null : Number(referrer_id),
    first_name,
    username,
    now,
    now,
  );
  return getUser(id);
}

/**
 * Create a user with an explicit referral code (used by the demo seeder).
 */
function createUser({ tg_id, first_name = 'User', username = null, referrer_id = null, code = null }) {
  const id = Number(tg_id);
  const now = nowIso();
  run(
    `INSERT INTO users (tg_id, code, referrer_id, first_name, username, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    code || generateCode(),
    referrer_id === null || referrer_id === undefined ? null : Number(referrer_id),
    first_name,
    username,
    now,
    now,
  );
  return getUser(id);
}

function setReferrer(tgId, referrerId) {
  run(
    'UPDATE users SET referrer_id = ? WHERE tg_id = ?',
    referrerId === null || referrerId === undefined ? null : Number(referrerId),
    Number(tgId),
  );
}

function setBanned(tgId, banned) {
  run('UPDATE users SET banned = ? WHERE tg_id = ?', banned ? 1 : 0, Number(tgId));
}

/** Credit the order owner: balance += amount + profit, total_profit += profit. */
function creditOwner(tgId, amount, profit) {
  const user = getUser(tgId);
  if (!user) return null;
  const balance = round2(user.balance + amount + profit);
  const totalProfit = round2(user.total_profit + profit);
  run('UPDATE users SET balance = ?, total_profit = ? WHERE tg_id = ?', balance, totalProfit, Number(tgId));
  return { balance, total_profit: totalProfit };
}

/** Credit an upline member: ref_balance += amount, total_ref += amount. */
function creditReferrer(tgId, amount) {
  const user = getUser(tgId);
  if (!user) return null;
  const refBalance = round2(user.ref_balance + amount);
  const totalRef = round2(user.total_ref + amount);
  run('UPDATE users SET ref_balance = ?, total_ref = ? WHERE tg_id = ?', refBalance, totalRef, Number(tgId));
  return { ref_balance: refBalance, total_ref: totalRef };
}

/**
 * Deduct a withdrawal: only balance / ref_balance move (total_profit and
 * total_ref keep tracking what was earned).
 */
function withdrawBalance(tgId, amount, source) {
  const user = getUser(tgId);
  if (!user) return null;
  const delta = round2(amount);
  if (source === 'ref') {
    const refBalance = round2(user.ref_balance - delta);
    run('UPDATE users SET ref_balance = ? WHERE tg_id = ?', refBalance, Number(tgId));
    return { balance: round2(user.balance), ref_balance: refBalance };
  }
  const balance = round2(user.balance - delta);
  run('UPDATE users SET balance = ? WHERE tg_id = ?', balance, Number(tgId));
  return { balance, ref_balance: round2(user.ref_balance) };
}

/** Admin balance adjustment (amount may be negative). source: deposit|ref. */
function adjustBalance(tgId, amount, source) {
  const user = getUser(tgId);
  if (!user) return null;
  const delta = round2(amount);
  if (source === 'ref') {
    const refBalance = round2(user.ref_balance + delta);
    run('UPDATE users SET ref_balance = ? WHERE tg_id = ?', refBalance, Number(tgId));
    return { balance: round2(user.balance), ref_balance: refBalance };
  }
  const balance = round2(user.balance + delta);
  run('UPDATE users SET balance = ? WHERE tg_id = ?', balance, Number(tgId));
  return { balance, ref_balance: round2(user.ref_balance) };
}

/** Direct children of a user. */
function childIds(tgId) {
  return all('SELECT tg_id FROM users WHERE referrer_id = ? ORDER BY created_at', Number(tgId)).map(
    (row) => row.tg_id,
  );
}

/**
 * Downline map: tg_id → level (1..maxLevel), capped at 50 hops overall.
 */
function downline(tgId, maxLevel = 3) {
  const levels = new Map();
  let frontier = [Number(tgId)];
  let visited = new Set(frontier);
  let hops = 0;
  for (let level = 1; level <= maxLevel && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      for (const child of childIds(id)) {
        hops += 1;
        if (hops > 5000 || visited.has(child)) continue; // safety cap
        visited.add(child);
        levels.set(child, level);
        next.push(child);
      }
    }
    frontier = next;
  }
  return levels;
}

/* -------------------------------------------------------------------------- */
/* admins                                                                      */
/* -------------------------------------------------------------------------- */

function isAdmin(tgId) {
  if (tgId === null || tgId === undefined) return false;
  const id = Number(tgId);
  if (config.ROOT_ADMIN_TG_ID !== null && id === config.ROOT_ADMIN_TG_ID) return true;
  return !!get('SELECT tg_id FROM admins WHERE tg_id = ?', id);
}

function isRoot(tgId) {
  if (tgId === null || tgId === undefined) return false;
  const id = Number(tgId);
  if (config.ROOT_ADMIN_TG_ID !== null && id === config.ROOT_ADMIN_TG_ID) return true;
  const row = get('SELECT is_root FROM admins WHERE tg_id = ?', id);
  return !!row && Number(row.is_root) === 1;
}

function listAdmins() {
  return all(
    `SELECT a.tg_id, a.added_by, a.is_root, a.created_at, u.first_name, u.username
       FROM admins a
       LEFT JOIN users u ON u.tg_id = a.tg_id
      ORDER BY a.is_root DESC, a.created_at ASC`,
  );
}

/* -------------------------------------------------------------------------- */
/* plans                                                                       */
/* -------------------------------------------------------------------------- */

function listPlans() {
  return all('SELECT * FROM plans ORDER BY sort ASC, min_amount ASC');
}

function getPlan(id) {
  if (id === null || id === undefined) return undefined;
  return get('SELECT * FROM plans WHERE id = ?', String(id));
}

/* -------------------------------------------------------------------------- */
/* settings                                                                    */
/* -------------------------------------------------------------------------- */

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', String(key));
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(key),
    String(value),
  );
}

function numSetting(key, fallback) {
  const raw = getSetting(key, null);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolSetting(key, fallback) {
  const raw = getSetting(key, null);
  if (raw === null) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/** Referral rates as fractions: { l1, l2, l3 }. */
function getRates() {
  return {
    l1: numSetting('rate_l1', 0.1),
    l2: numSetting('rate_l2', 0.07),
    l3: numSetting('rate_l3', 0.05),
  };
}

function referralEnabled() {
  return boolSetting('referral_enabled', true);
}

/** Settings row wins over the .env default (API.md). */
function autoApproveOrders() {
  return boolSetting('auto_approve_orders', config.AUTO_APPROVE_ORDERS);
}

function settingsObject() {
  return {
    rate_l1: numSetting('rate_l1', 0.1),
    rate_l2: numSetting('rate_l2', 0.07),
    rate_l3: numSetting('rate_l3', 0.05),
    auto_approve_orders: autoApproveOrders(),
    referral_enabled: referralEnabled(),
  };
}

/* -------------------------------------------------------------------------- */
/* aggregates used by /api/me and /api/referral (computed from real rows)      */
/* -------------------------------------------------------------------------- */

/** Sum of `profit` of completed orders per user → Map<tg_id, number>. */
function completedProfitByUser(userIds) {
  const map = new Map();
  const ids = [...new Set(userIds.map(Number))].filter((id) => Number.isFinite(id));
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = all(
    `SELECT user_id, IFNULL(SUM(profit), 0) AS profit
       FROM orders
      WHERE status = 'completed' AND user_id IN (${placeholders})
      GROUP BY user_id`,
    ...ids,
  );
  for (const row of rows) map.set(Number(row.user_id), round2(row.profit));
  return map;
}

/** What `tgId` earned from referrals, per level → Map<level, number>. */
function earnedByLevel(tgId) {
  const map = new Map();
  const rows = all(
    'SELECT level, IFNULL(SUM(amount), 0) AS amount FROM accruals WHERE user_id = ? GROUP BY level',
    Number(tgId),
  );
  for (const row of rows) map.set(Number(row.level), round2(row.amount));
  return map;
}

/** What `tgId` earned from one specific downline member. */
function earnedFrom(tgId, fromUserId) {
  const row = get(
    'SELECT IFNULL(SUM(amount), 0) AS amount FROM accruals WHERE user_id = ? AND from_user_id = ?',
    Number(tgId),
    Number(fromUserId),
  );
  return round2(row ? row.amount : 0);
}

seed();

/* -------------------------------------------------------------------------- */

module.exports = {
  // raw access
  db,
  prep,
  get,
  all,
  run,
  transaction,
  openDatabase,
  seed,

  // helpers
  round2,
  nowIso,
  isoIn,
  generateCode,

  // users
  getUser,
  getUserByCode,
  ensureUser,
  createUser,
  setReferrer,
  setBanned,
  creditOwner,
  creditReferrer,
  adjustBalance,
  withdrawBalance,
  childIds,
  downline,

  // admins
  isAdmin,
  isRoot,
  listAdmins,

  // plans
  listPlans,
  getPlan,

  // settings
  getSetting,
  setSetting,
  getRates,
  referralEnabled,
  autoApproveOrders,
  settingsObject,

  // aggregates
  completedProfitByUser,
  earnedByLevel,
  earnedFrom,
};
