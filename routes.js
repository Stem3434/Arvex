'use strict';

/**
 * ARVEX HTTP layer — every endpoint from API.md.
 *
 *   public : GET /api/health, GET /api/config, POST /api/auth
 *   user   : GET /api/me, GET|POST /api/orders, GET /api/referral,
 *            GET|POST /api/withdrawals
 *   admin  : /api/admin/*  (Bearer token of a row in `admins`)
 *   static : /  → public/index.html, /admin → public/admin.html, /assets/*
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const orders = require('./referral');

const { round2, nowIso, isoIn } = db;
const { httpError } = auth;

/* -------------------------------------------------------------------------- */
/* validation helpers — client input is never trusted                          */
/* -------------------------------------------------------------------------- */

function fail(status, message, extra) {
  throw httpError(status, message, extra);
}

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function str(value, name, { required = false, max = 255 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, `missing_${name}`);
    return null;
  }
  if (typeof value !== 'string') fail(400, `invalid_${name}`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) fail(400, `missing_${name}`);
    return null;
  }
  return trimmed.slice(0, max);
}

function num(value, name, { required = false, min, max, integer = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, `missing_${name}`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) fail(400, `invalid_${name}`);
  if (integer && !Number.isInteger(n)) fail(400, `invalid_${name}`);
  if (min !== undefined && n < min) fail(400, `invalid_${name}`, { [name]: { min } });
  if (max !== undefined && n > max) fail(400, `invalid_${name}`, { [name]: { max } });
  return n;
}

/** Positive safe integer id (Telegram user id / numeric pk). */
function idOf(value, name = 'id') {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(400, `invalid_${name}`);
  return n;
}

function boolOf(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, `missing_${name}`);
    return null;
  }
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  fail(400, `invalid_${name}`);
  return null;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) fail(400, `invalid_${name}`, { allowed });
  return value;
}

function intParam(value, name, fallback, { min = 0, max = 1000 } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) fail(400, `invalid_${name}`);
  return Math.min(max, Math.max(min, n));
}

/** Admin mutations that have no reviewed_by column are logged with the actor. */
function audit(req, action, detail) {
  console.log(`[arvex:audit] admin=${req.user.tg_id} ${action} ${JSON.stringify(detail)}`);
}

/* -------------------------------------------------------------------------- */
/* view helpers                                                                */
/* -------------------------------------------------------------------------- */

const ORDER_STATUSES = ['pending', 'active', 'completed', 'rejected'];
const WITHDRAWAL_STATUSES = ['pending', 'approved', 'rejected'];

function planView(plan, { withSort = false } = {}) {
  if (!plan) return null;
  const view = {
    id: plan.id,
    name: plan.name,
    min_amount: round2(plan.min_amount),
    max_amount: round2(plan.max_amount),
    rate_lo: Number(plan.rate_lo),
    rate_hi: Number(plan.rate_hi),
    period_hours: Number(plan.period_hours),
    enabled: Number(plan.enabled) === 1,
  };
  if (withSort) view.sort = Number(plan.sort);
  return view;
}

function withdrawalView(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: row.user_id === undefined ? undefined : Number(row.user_id),
    user_name: row.user_name === undefined ? undefined : row.user_name,
    amount: round2(row.amount),
    source: row.source,
    status: row.status,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at === undefined ? null : row.reviewed_at,
    reviewed_by: row.reviewed_by === undefined || row.reviewed_by === null ? null : Number(row.reviewed_by),
    note: row.note === undefined ? null : row.note,
  };
}

function accrualView(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: row.user_id === undefined ? undefined : Number(row.user_id),
    user_name: row.user_name === undefined ? undefined : row.user_name,
    order_id: Number(row.order_id),
    level: Number(row.level),
    from_user_id: row.from_user_id === undefined ? undefined : Number(row.from_user_id),
    from_name: row.from_name === undefined ? undefined : row.from_name,
    from_username: row.from_username === undefined ? undefined : row.from_username,
    base_profit: round2(row.base_profit),
    rate: Number(row.rate),
    amount: round2(row.amount),
    created_at: row.created_at,
  };
}

function briefUser(row) {
  if (!row) return null;
  return {
    tg_id: Number(row.tg_id),
    code: row.code,
    first_name: row.first_name ?? null,
    username: row.username ?? null,
    joined_at: row.created_at,
    created_at: row.created_at,
  };
}

/**
 * partners / profit / earned per referral level, always computed from real rows.
 */
function referralStats(tgId, maxLevel = 3) {
  const rates = db.getRates();
  const members = db.downline(tgId, maxLevel); // Map<tg_id, level>
  const profitByUser = db.completedProfitByUser([...members.keys()]);
  const earnedLevels = db.earnedByLevel(tgId);

  const partners = { l1: 0, l2: 0, l3: 0 };
  const profit = { l1: 0, l2: 0, l3: 0 };
  for (const [memberId, level] of members) {
    const key = `l${level}`;
    if (partners[key] === undefined) continue;
    partners[key] += 1;
    profit[key] = round2(profit[key] + (profitByUser.get(memberId) || 0));
  }
  const earned = { l1: 0, l2: 0, l3: 0 };
  for (const [level, amount] of earnedLevels) {
    const key = `l${level}`;
    if (earned[key] !== undefined) earned[key] = round2(amount);
  }
  const sum = (obj) => round2(obj.l1 + obj.l2 + obj.l3);
  return {
    partners: { ...partners, total: partners.l1 + partners.l2 + partners.l3 },
    profit: { ...profit, total: sum(profit) },
    earned: { ...earned, total: sum(earned) },
    rates,
    members,
    profitByUser,
  };
}

/** Map<from_user_id, amount earned from that member> for one upline user. */
function earnedByMember(tgId) {
  const map = new Map();
  const rows = db.all(
    'SELECT from_user_id, IFNULL(SUM(amount), 0) AS amount FROM accruals WHERE user_id = ? GROUP BY from_user_id',
    Number(tgId),
  );
  for (const row of rows) map.set(Number(row.from_user_id), round2(row.amount));
  return map;
}

/* -------------------------------------------------------------------------- */
/* middleware                                                                  */
/* -------------------------------------------------------------------------- */

function resolveSession(req) {
  const session = auth.sessionUser(req);
  if (!session) return null;
  req.token = session.token;
  req.user = session.user;
  return session;
}

function requireUser(req, res, next) {
  if (!resolveSession(req)) return next(httpError(401, 'unauthorized'));
  if (Number(req.user.banned) === 1) return next(httpError(403, 'forbidden', { banned: true }));
  next();
}

function requireAdmin(req, res, next) {
  if (!resolveSession(req)) return next(httpError(401, 'unauthorized'));
  if (Number(req.user.banned) === 1) return next(httpError(403, 'forbidden', { banned: true }));
  if (!auth.verifyAdmin(req.user.tg_id)) return next(httpError(403, 'forbidden'));
  req.isAdmin = true;
  req.isRoot = db.isRoot(req.user.tg_id);
  next();
}

/** async-aware handler wrapper */
function wrap(handler) {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then((value) => { if (value !== undefined && !res.headersSent) res.json(value); }, next);
      } else if (result !== undefined && !res.headersSent) {
        res.json(result);
      }
      return undefined;
    } catch (error) {
      next(error);
      return undefined;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* router                                                                      */
/* -------------------------------------------------------------------------- */

function createRouter() {
  const router = express.Router();

  /* ----------------------------- public ---------------------------------- */

  router.get(
    '/api/health',
    wrap(() => ({ ok: true, mode: config.INSECURE ? 'insecure' : 'secure' })),
  );

  router.get(
    '/api/config',
    wrap(() => {
      const rates = db.getRates();
      return {
        plans: db.listPlans().map((plan) => planView(plan)),
        rates: { l1: rates.l1, l2: rates.l2, l3: rates.l3 },
        referral_enabled: db.referralEnabled(),
        auto_approve_orders: db.autoApproveOrders(),
        bot_username: config.INVITE_BOT_USERNAME,
        root_admin_configured: config.ROOT_ADMIN_TG_ID !== null,
      };
    }),
  );

  router.post(
    '/api/auth',
    wrap((req) => auth.login(body(req))),
  );

  /* ------------------------------ user ----------------------------------- */

  router.get(
    '/api/me',
    requireUser,
    wrap((req) => {
      orders.tick(); // rule 4: the completion timer also runs on /api/me reads
      const user = db.getUser(req.user.tg_id);
      const count = db.get('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?', Number(user.tg_id));
      const stats = referralStats(user.tg_id);
      return {
        user: auth.serializeUser(user),
        orders_count: Number(count.c),
        stats: { partners: stats.partners, profit: stats.profit, earned: stats.earned },
      };
    }),
  );

  router.get(
    '/api/orders',
    requireUser,
    wrap((req) => {
      const rows = db.all(
        `SELECT o.*, p.name AS plan_name
           FROM orders o LEFT JOIN plans p ON p.id = o.plan_id
          WHERE o.user_id = ?
          ORDER BY o.created_at DESC, o.id DESC`,
        Number(req.user.tg_id),
      );
      return { orders: rows.map((row) => orders.orderView(row)) };
    }),
  );

  router.post(
    '/api/orders',
    requireUser,
    wrap((req) => {
      const payload = body(req);
      const planId = str(payload.plan_id, 'plan_id', { required: true, max: 32 });
      const amount = num(payload.amount, 'amount', { required: true });
      const rate = num(payload.rate, 'rate', { required: true });
      const order = orders.createOrder({ userId: req.user.tg_id, planId, amount, rate });
      return { order: orders.orderView(orders.getOrderDetailed(order.id)) };
    }),
  );

  router.get(
    '/api/referral',
    requireUser,
    wrap((req) => {
      const user = db.getUser(req.user.tg_id);
      const rates = db.getRates();
      const stats = referralStats(user.tg_id);
      const earnedFromMember = earnedByMember(user.tg_id);

      // per-member detail of the 3 downline levels (real rows only)
      const memberIds = [...stats.members.keys()];
      const details = new Map();
      if (memberIds.length) {
        const placeholders = memberIds.map(() => '?').join(',');
        for (const row of db.all(`SELECT * FROM users WHERE tg_id IN (${placeholders})`, ...memberIds)) {
          details.set(Number(row.tg_id), row);
        }
      }
      const partners = memberIds
        .map((id) => {
          const row = details.get(id);
          if (!row) return null;
          return {
            level: stats.members.get(id),
            tg_id: Number(row.tg_id),
            first_name: row.first_name ?? null,
            username: row.username ?? null,
            joined_at: row.created_at,
            profit: round2(stats.profitByUser.get(id) || 0),
            earned: round2(earnedFromMember.get(id) || 0),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.level - b.level || String(a.joined_at).localeCompare(String(b.joined_at)));

      const accrualRows = db.all(
        `SELECT a.*, u.first_name AS from_name, u.username AS from_username
           FROM accruals a LEFT JOIN users u ON u.tg_id = a.from_user_id
          WHERE a.user_id = ?
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 200`,
        Number(user.tg_id),
      );

      const levels = [1, 2, 3].map((level) => ({
        level,
        rate: rates[`l${level}`],
        partners: stats.partners[`l${level}`],
        profit: round2(stats.profit[`l${level}`]),
        earned: round2(stats.earned[`l${level}`]),
      }));

      return {
        code: user.code,
        link: `https://t.me/${config.INVITE_BOT_USERNAME}?start=ref_${user.code}`,
        rates: { l1: rates.l1, l2: rates.l2, l3: rates.l3 },
        ref_balance: round2(user.ref_balance),
        total_ref: round2(user.total_ref),
        levels,
        accruals: accrualRows.map((row) => ({
          id: Number(row.id),
          level: Number(row.level),
          from_name: row.from_name ?? null,
          from_username: row.from_username ?? null,
          base_profit: round2(row.base_profit),
          rate: Number(row.rate),
          amount: round2(row.amount),
          created_at: row.created_at,
        })),
        partners,
        enabled: db.referralEnabled(),
      };
    }),
  );

  router.post(
    '/api/withdrawals',
    requireUser,
    wrap((req) => {
      const payload = body(req);
      const source = str(payload.source, 'source', { max: 16 }) || 'deposit';
      oneOf(source, ['deposit', 'ref'], 'source');
      const amount = round2(num(payload.amount, 'amount', { required: true }));
      if (!(amount > 0)) fail(400, 'invalid_amount');

      const user = db.getUser(req.user.tg_id);
      const available = round2(source === 'ref' ? user.ref_balance : user.balance);
      if (amount > available) fail(400, 'insufficient_balance', { available, source });

      const info = db.run(
        `INSERT INTO withdrawals (user_id, amount, source, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
        Number(user.tg_id),
        amount,
        source,
        nowIso(),
      );
      return { withdrawal: withdrawalView(db.get('SELECT * FROM withdrawals WHERE id = ?', Number(info.lastInsertRowid))) };
    }),
  );

  router.get(
    '/api/withdrawals',
    requireUser,
    wrap((req) => {
      const rows = db.all(
        'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC, id DESC',
        Number(req.user.tg_id),
      );
      return { withdrawals: rows.map(withdrawalView) };
    }),
  );

  /* ------------------------------ admin ---------------------------------- */

  router.get(
    '/api/admin/overview',
    requireAdmin,
    wrap(() => {
      const statusCounts = new Map();
      for (const row of db.all('SELECT status, COUNT(*) AS c FROM orders GROUP BY status')) {
        statusCounts.set(row.status, Number(row.c));
      }
      const money = db.get(
        `SELECT IFNULL(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) AS deposits,
                IFNULL(SUM(CASE WHEN status = 'completed' THEN profit  ELSE 0 END), 0) AS profit
           FROM orders`,
      );
      const ref = db.get('SELECT IFNULL(SUM(amount), 0) AS total FROM accruals');
      const pendingWithdrawals = db.get(
        "SELECT COUNT(*) AS c, IFNULL(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'pending'",
      );
      const users = db.get('SELECT COUNT(*) AS c FROM users');

      // by_day: orders + profit + referral payouts per calendar day (UTC)
      const days = new Map();
      const dayOf = (date) => {
        if (!days.has(date)) days.set(date, { date, orders: 0, profit: 0, ref: 0 });
        return days.get(date);
      };
      for (const row of db.all(
        `SELECT substr(created_at, 1, 10) AS date,
                COUNT(*) AS orders,
                IFNULL(SUM(CASE WHEN status = 'completed' THEN profit ELSE 0 END), 0) AS profit
           FROM orders GROUP BY date`,
      )) {
        if (!row.date) continue;
        const day = dayOf(row.date);
        day.orders = Number(row.orders);
        day.profit = round2(row.profit);
      }
      for (const row of db.all('SELECT substr(created_at, 1, 10) AS date, IFNULL(SUM(amount), 0) AS ref FROM accruals GROUP BY date')) {
        if (!row.date) continue;
        dayOf(row.date).ref = round2(row.ref);
      }
      const byDay = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);

      const recentOrders = db
        .all(
          `SELECT o.*, p.name AS plan_name, u.first_name AS user_name, u.tg_id AS user_tg_id
             FROM orders o
             LEFT JOIN plans p ON p.id = o.plan_id
             LEFT JOIN users u ON u.tg_id = o.user_id
            ORDER BY o.created_at DESC, o.id DESC LIMIT 12`,
        )
        .map((row) => orders.orderView(row));

      const recentAccruals = db
        .all(
          `SELECT a.*, u.first_name AS user_name, f.first_name AS from_name, f.username AS from_username
             FROM accruals a
             LEFT JOIN users u ON u.tg_id = a.user_id
             LEFT JOIN users f ON f.tg_id = a.from_user_id
            ORDER BY a.created_at DESC, a.id DESC LIMIT 12`,
        )
        .map(accrualView);

      return {
        totals: {
          users: Number(users.c),
          orders_pending: statusCounts.get('pending') || 0,
          orders_active: statusCounts.get('active') || 0,
          orders_completed: statusCounts.get('completed') || 0,
          deposits_volume: round2(money.deposits),
          profit_paid: round2(money.profit),
          ref_paid: round2(ref.total),
          withdrawals_pending: Number(pendingWithdrawals.c),
          withdrawals_pending_amount: round2(pendingWithdrawals.total),
        },
        by_day: byDay,
        recent_orders: recentOrders,
        recent_accruals: recentAccruals,
      };
    }),
  );

  router.get(
    '/api/admin/users',
    requireAdmin,
    wrap((req) => {
      const q = String(req.query.q || '').trim();
      const limit = intParam(req.query.limit, 'limit', 50, { min: 1, max: 200 });
      const offset = intParam(req.query.offset, 'offset', 0, { min: 0, max: 1e9 });

      let where = '';
      const params = [];
      if (q) {
        const like = `%${q.toLowerCase()}%`;
        where =
          ' WHERE CAST(u.tg_id AS TEXT) LIKE ? OR LOWER(IFNULL(u.code, \'\')) LIKE ?' +
          " OR LOWER(IFNULL(u.first_name, '')) LIKE ? OR LOWER(IFNULL(u.username, '')) LIKE ?";
        params.push(like, like, like, like);
      }

      const total = db.get(`SELECT COUNT(*) AS c FROM users u${where}`, ...params);
      const rows = db.all(
        `SELECT u.*,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.tg_id) AS orders,
                r.first_name AS referrer_name,
                r.tg_id AS referrer_tg_id
           FROM users u
           LEFT JOIN users r ON r.tg_id = u.referrer_id
           ${where}
          ORDER BY u.created_at DESC, u.tg_id DESC
          LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
      return {
        users: rows.map((row) => ({
          tg_id: Number(row.tg_id),
          first_name: row.first_name ?? null,
          username: row.username ?? null,
          code: row.code,
          balance: round2(row.balance),
          ref_balance: round2(row.ref_balance),
          total_profit: round2(row.total_profit),
          total_ref: round2(row.total_ref),
          banned: Number(row.banned) === 1,
          is_admin: db.isAdmin(row.tg_id),
          is_root: db.isRoot(row.tg_id),
          created_at: row.created_at,
          orders: Number(row.orders),
          referrer_name: row.referrer_name ?? null,
          referrer_tg_id: row.referrer_tg_id === null || row.referrer_tg_id === undefined ? null : Number(row.referrer_tg_id),
        })),
        total: Number(total.c),
      };
    }),
  );

  router.get(
    '/api/admin/users/:id',
    requireAdmin,
    wrap((req) => {
      const tgId = idOf(req.params.id, 'id');
      const user = db.getUser(tgId);
      if (!user) fail(404, 'user_not_found');

      const orderRows = db.all(
        `SELECT o.*, p.name AS plan_name FROM orders o LEFT JOIN plans p ON p.id = o.plan_id
          WHERE o.user_id = ? ORDER BY o.created_at DESC, o.id DESC`,
        tgId,
      );
      const accrualRows = db.all(
        `SELECT a.*, f.first_name AS from_name, f.username AS from_username
           FROM accruals a LEFT JOIN users f ON f.tg_id = a.from_user_id
          WHERE a.user_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
        tgId,
      );
      const withdrawalRows = db.all(
        'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC, id DESC',
        tgId,
      );

      const stats = referralStats(tgId, 3);
      const memberIds = [...stats.members.keys()];
      const tree = { l1: [], l2: [], l3: [] };
      if (memberIds.length) {
        const placeholders = memberIds.map(() => '?').join(',');
        for (const row of db.all(`SELECT * FROM users WHERE tg_id IN (${placeholders})`, ...memberIds)) {
          const level = stats.members.get(Number(row.tg_id));
          const key = `l${level}`;
          if (!tree[key]) continue;
          tree[key].push({
            ...briefUser(row),
            balance: round2(row.balance),
            profit: round2(stats.profitByUser.get(Number(row.tg_id)) || 0),
          });
        }
      }
      for (const key of ['l1', 'l2', 'l3']) {
        tree[key].sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)));
      }

      const parent = user.referrer_id ? db.getUser(user.referrer_id) : null;
      const orderCount = db.get('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?', tgId);

      return {
        user: {
          ...auth.serializeUser(user),
          created_at: user.created_at,
          last_seen_at: user.last_seen_at,
          consent: Number(user.consent) === 1,
          orders_count: Number(orderCount.c),
        },
        orders: orderRows.map((row) => orders.orderView(row)),
        accruals: accrualRows.map(accrualView),
        withdrawals: withdrawalRows.map(withdrawalView),
        tree,
        parent: parent ? briefUser(parent) : null,
      };
    }),
  );

  router.post(
    '/api/admin/users/:id/ban',
    requireAdmin,
    wrap((req) => {
      const tgId = idOf(req.params.id, 'id');
      const banned = boolOf(body(req).banned, 'banned', { required: true });
      const target = db.getUser(tgId);
      if (!target) fail(404, 'user_not_found');
      if (db.isRoot(tgId)) fail(403, 'root_immutable'); // the root admin can never be banned
      if (db.isAdmin(tgId) && !req.isRoot) fail(403, 'root_only'); // only root may ban an admin

      db.setBanned(tgId, banned);
      audit(req, banned ? 'user.ban' : 'user.unban', { tg_id: tgId });
      return { ok: true, banned, user: auth.serializeUser(db.getUser(tgId)) };
    }),
  );

  router.post(
    '/api/admin/users/:id/balance',
    requireAdmin,
    wrap((req) => {
      const tgId = idOf(req.params.id, 'id');
      const payload = body(req);
      const target = db.getUser(tgId);
      if (!target) fail(404, 'user_not_found');
      const amount = round2(num(payload.amount, 'amount', { required: true }));
      const source = str(payload.source, 'source', { max: 16 }) || 'deposit';
      oneOf(source, ['deposit', 'ref'], 'source');
      const note = str(payload.note, 'note', { max: 255 });

      const balances = db.adjustBalance(tgId, amount, source);
      audit(req, 'user.balance', { tg_id: tgId, amount, source, note, reviewed_by: req.user.tg_id });
      return { ok: true, balance: balances.balance, ref_balance: balances.ref_balance };
    }),
  );

  router.post(
    '/api/admin/users/:id/parent',
    requireAdmin,
    wrap((req) => {
      const tgId = idOf(req.params.id, 'id');
      const target = db.getUser(tgId);
      if (!target) fail(404, 'user_not_found');

      const raw = body(req).parent_id;
      if (raw === undefined) fail(400, 'missing_parent_id');
      if (raw === null || raw === '') {
        db.setReferrer(tgId, null);
        audit(req, 'user.parent', { tg_id: tgId, parent_id: null });
        return { ok: true, parent_id: null };
      }
      const parentId = idOf(raw, 'parent_id');
      if (parentId === tgId) fail(400, 'self_parent');
      if (!db.getUser(parentId)) fail(404, 'parent_not_found');
      if (auth.wouldCreateCycle(tgId, parentId)) fail(400, 'cycle_not_allowed');

      db.setReferrer(tgId, parentId);
      audit(req, 'user.parent', { tg_id: tgId, parent_id: parentId });
      return { ok: true, parent_id: parentId };
    }),
  );

  router.get(
    '/api/admin/orders',
    requireAdmin,
    wrap((req) => {
      const status = req.query.status === undefined || req.query.status === '' ? null : String(req.query.status);
      if (status !== null) oneOf(status, ORDER_STATUSES, 'status');
      const rows = db.all(
        `SELECT o.*, p.name AS plan_name, u.first_name AS user_name, u.tg_id AS user_tg_id
           FROM orders o
           LEFT JOIN plans p ON p.id = o.plan_id
           LEFT JOIN users u ON u.tg_id = o.user_id
          ${status ? 'WHERE o.status = ?' : ''}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT 500`,
        ...(status ? [status] : []),
      );
      return { orders: rows.map((row) => orders.orderView(row)) };
    }),
  );

  router.post(
    '/api/admin/orders/:id/approve',
    requireAdmin,
    wrap((req) => {
      const id = idOf(req.params.id, 'id');
      const result = orders.activateOrder(id, req.user.tg_id);
      if (!result.ok) {
        if (result.reason === 'not_found') fail(404, 'order_not_found');
        fail(409, result.reason);
      }
      return { order: orders.orderView(result.order) };
    }),
  );

  router.post(
    '/api/admin/orders/:id/reject',
    requireAdmin,
    wrap((req) => {
      const id = idOf(req.params.id, 'id');
      const note = str(body(req).note, 'note', { max: 255 });
      const result = orders.rejectOrder(id, req.user.tg_id, note);
      if (!result.ok) {
        if (result.reason === 'not_found') fail(404, 'order_not_found');
        fail(409, result.reason);
      }
      return { order: orders.orderView(result.order) };
    }),
  );

  router.post(
    '/api/admin/orders/:id/complete',
    requireAdmin,
    wrap((req) => {
      const id = idOf(req.params.id, 'id');
      const result = orders.completeOrder(id, { reviewedBy: req.user.tg_id });
      if (!result.ok) {
        if (result.reason === 'not_found') fail(404, 'order_not_found');
        fail(409, result.reason);
      }
      return { order: orders.orderView(result.order) };
    }),
  );

  router.get(
    '/api/admin/accruals',
    requireAdmin,
    wrap((req) => {
      const limit = intParam(req.query.limit, 'limit', 100, { min: 1, max: 500 });
      const rows = db.all(
        `SELECT a.*, u.first_name AS user_name, f.first_name AS from_name, f.username AS from_username
           FROM accruals a
           LEFT JOIN users u ON u.tg_id = a.user_id
           LEFT JOIN users f ON f.tg_id = a.from_user_id
          ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
        limit,
      );
      return { accruals: rows.map(accrualView) };
    }),
  );

  router.get(
    '/api/admin/withdrawals',
    requireAdmin,
    wrap((req) => {
      const status = req.query.status === undefined || req.query.status === '' ? null : String(req.query.status);
      if (status !== null) oneOf(status, WITHDRAWAL_STATUSES, 'status');
      const rows = db.all(
        `SELECT w.*, u.first_name AS user_name
           FROM withdrawals w LEFT JOIN users u ON u.tg_id = w.user_id
          ${status ? 'WHERE w.status = ?' : ''}
          ORDER BY w.created_at DESC, w.id DESC
          LIMIT 500`,
        ...(status ? [status] : []),
      );
      return { withdrawals: rows.map(withdrawalView) };
    }),
  );

  router.post(
    '/api/admin/withdrawals/:id/approve',
    requireAdmin,
    wrap((req) => {
      const id = idOf(req.params.id, 'id');
      const row = db.get('SELECT * FROM withdrawals WHERE id = ?', id);
      if (!row) fail(404, 'withdrawal_not_found');
      if (row.status !== 'pending') fail(409, 'not_pending');

      const user = db.getUser(row.user_id);
      if (!user) fail(404, 'user_not_found');
      const amount = round2(row.amount);
      const available = round2(row.source === 'ref' ? user.ref_balance : user.balance);
      if (amount > available) fail(409, 'insufficient_balance', { available, source: row.source });

      db.withdrawBalance(user.tg_id, amount, row.source); // deduct on approval
      const note = str(body(req).note, 'note', { max: 255 });
      db.run(
        "UPDATE withdrawals SET status = 'approved', reviewed_at = ?, reviewed_by = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'pending'",
        nowIso(),
        Number(req.user.tg_id),
        note,
        id,
      );
      audit(req, 'withdrawal.approve', { id, amount, source: row.source, reviewed_by: req.user.tg_id });
      return { withdrawal: withdrawalView(db.get('SELECT * FROM withdrawals WHERE id = ?', id)) };
    }),
  );

  router.post(
    '/api/admin/withdrawals/:id/reject',
    requireAdmin,
    wrap((req) => {
      const id = idOf(req.params.id, 'id');
      const row = db.get('SELECT * FROM withdrawals WHERE id = ?', id);
      if (!row) fail(404, 'withdrawal_not_found');
      if (row.status !== 'pending') fail(409, 'not_pending');
      const note = str(body(req).note, 'note', { max: 255 });
      db.run(
        "UPDATE withdrawals SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'pending'",
        nowIso(),
        Number(req.user.tg_id),
        note,
        id,
      );
      audit(req, 'withdrawal.reject', { id, reviewed_by: req.user.tg_id });
      return { withdrawal: withdrawalView(db.get('SELECT * FROM withdrawals WHERE id = ?', id)) };
    }),
  );

  router.get(
    '/api/admin/plans',
    requireAdmin,
    wrap(() => ({ plans: db.listPlans().map((plan) => planView(plan, { withSort: true })) })),
  );

  router.put(
    '/api/admin/plans/:id',
    requireAdmin,
    wrap((req) => {
      const planId = String(req.params.id);
      const plan = db.getPlan(planId);
      if (!plan) fail(404, 'plan_not_found');
      const payload = body(req);

      const next = {
        name: plan.name,
        min_amount: Number(plan.min_amount),
        max_amount: Number(plan.max_amount),
        rate_lo: Number(plan.rate_lo),
        rate_hi: Number(plan.rate_hi),
        period_hours: Number(plan.period_hours),
        enabled: Number(plan.enabled) === 1,
      };

      if (payload.name !== undefined) next.name = str(payload.name, 'name', { required: true, max: 64 });
      if (payload.min_amount !== undefined) next.min_amount = round2(num(payload.min_amount, 'min_amount', { required: true, min: 0 }));
      if (payload.max_amount !== undefined) next.max_amount = round2(num(payload.max_amount, 'max_amount', { required: true, min: 0 }));
      if (payload.rate_lo !== undefined) next.rate_lo = num(payload.rate_lo, 'rate_lo', { required: true, min: 0, max: 1 });
      if (payload.rate_hi !== undefined) next.rate_hi = num(payload.rate_hi, 'rate_hi', { required: true, min: 0, max: 1 });
      if (payload.period_hours !== undefined) {
        next.period_hours = num(payload.period_hours, 'period_hours', { required: true, integer: true, min: 1 });
      }
      if (payload.enabled !== undefined) next.enabled = boolOf(payload.enabled, 'enabled', { required: true });

      if (next.min_amount > next.max_amount) fail(400, 'invalid_amount_range');
      if (next.rate_lo > next.rate_hi) fail(400, 'invalid_rate_range');

      const fields = [];
      const params = [];
      if (payload.name !== undefined) {
        fields.push('name = ?');
        params.push(next.name);
      }
      if (payload.min_amount !== undefined) {
        fields.push('min_amount = ?');
        params.push(next.min_amount);
      }
      if (payload.max_amount !== undefined) {
        fields.push('max_amount = ?');
        params.push(next.max_amount);
      }
      if (payload.rate_lo !== undefined) {
        fields.push('rate_lo = ?');
        params.push(next.rate_lo);
      }
      if (payload.rate_hi !== undefined) {
        fields.push('rate_hi = ?');
        params.push(next.rate_hi);
      }
      if (payload.period_hours !== undefined) {
        fields.push('period_hours = ?');
        params.push(next.period_hours);
      }
      if (payload.enabled !== undefined) {
        fields.push('enabled = ?');
        params.push(next.enabled ? 1 : 0);
      }
      if (fields.length) {
        db.run(`UPDATE plans SET ${fields.join(', ')} WHERE id = ?`, ...params, planId);
      }
      audit(req, 'plan.update', { id: planId, changes: Object.keys(payload), by: req.user.tg_id });
      return { plan: planView(db.getPlan(planId), { withSort: true }) };
    }),
  );

  router.get(
    '/api/admin/settings',
    requireAdmin,
    wrap(() => ({ settings: db.settingsObject() })),
  );

  router.put(
    '/api/admin/settings',
    requireAdmin,
    wrap((req) => {
      const payload = body(req);
      for (const key of ['rate_l1', 'rate_l2', 'rate_l3']) {
        if (payload[key] === undefined) continue;
        const value = num(payload[key], key, { required: true, min: 0, max: 1 });
        db.setSetting(key, String(value));
      }
      for (const key of ['auto_approve_orders', 'referral_enabled']) {
        if (payload[key] === undefined) continue;
        db.setSetting(key, boolOf(payload[key], key, { required: true }) ? '1' : '0');
      }
      audit(req, 'settings.update', { changes: Object.keys(payload), by: req.user.tg_id });
      return { settings: db.settingsObject() };
    }),
  );

  router.get(
    '/api/admin/admins',
    requireAdmin,
    wrap((req) => {
      const admins = db.listAdmins().map((row) => ({
        tg_id: Number(row.tg_id),
        first_name: row.first_name ?? null,
        username: row.username ?? null,
        is_root: Number(row.is_root) === 1,
        added_by: row.added_by === null || row.added_by === undefined ? null : Number(row.added_by),
        created_at: row.created_at,
      }));
      const rootRow = admins.find((admin) => admin.is_root);
      return {
        admins,
        root_id: config.ROOT_ADMIN_TG_ID !== null ? config.ROOT_ADMIN_TG_ID : rootRow ? rootRow.tg_id : null,
        can_manage: req.isRoot,
      };
    }),
  );

  router.post(
    '/api/admin/admins',
    requireAdmin,
    wrap((req) => {
      if (!req.isRoot) fail(403, 'root_only');
      const payload = body(req);
      const tgId = idOf(payload.tg_id, 'tg_id');
      const firstName = str(payload.first_name, 'first_name', { max: 64 });

      if (db.isAdmin(tgId)) fail(409, 'already_admin');
      if (!db.getUser(tgId)) {
        db.createUser({ tg_id: tgId, first_name: firstName || 'Admin', username: null });
      }
      db.run(
        'INSERT INTO admins (tg_id, added_by, is_root, created_at) VALUES (?, ?, ?, ?)',
        tgId,
        Number(req.user.tg_id), // added_by is always the acting admin, never a client value
        config.ROOT_ADMIN_TG_ID !== null && tgId === config.ROOT_ADMIN_TG_ID ? 1 : 0,
        nowIso(),
      );
      audit(req, 'admin.add', { tg_id: tgId, added_by: req.user.tg_id });
      const row = db.get(
        `SELECT a.*, u.first_name, u.username FROM admins a
         LEFT JOIN users u ON u.tg_id = a.tg_id WHERE a.tg_id = ?`,
        tgId,
      );
      return {
        admin: {
          tg_id: Number(row.tg_id),
          first_name: row.first_name ?? null,
          username: row.username ?? null,
          is_root: Number(row.is_root) === 1,
          added_by: row.added_by === null || row.added_by === undefined ? null : Number(row.added_by),
          created_at: row.created_at,
        },
      };
    }),
  );

  router.post(
    '/api/admin/admins/:id/revoke',
    requireAdmin,
    wrap((req) => {
      if (!req.isRoot) fail(403, 'root_only');
      const tgId = idOf(req.params.id, 'id');
      const row = db.get('SELECT * FROM admins WHERE tg_id = ?', tgId);
      if (!row) fail(404, 'admin_not_found');
      if (Number(row.is_root) === 1 || (config.ROOT_ADMIN_TG_ID !== null && tgId === config.ROOT_ADMIN_TG_ID)) {
        fail(409, 'root_immutable');
      }
      db.run('DELETE FROM admins WHERE tg_id = ? AND is_root = 0', tgId);
      audit(req, 'admin.revoke', { tg_id: tgId, revoked_by: req.user.tg_id });
      return { ok: true };
    }),
  );

  router.post(
    '/api/admin/seed-demo',
    requireAdmin,
    wrap((req) => {
      const DEMO_IDS = [900000001, 900000002, 900000003];
      for (const id of DEMO_IDS) {
        if (db.getUser(id)) fail(409, 'demo_exists');
      }
      const plan = db.getPlan('start');
      if (!plan) fail(409, 'plan_missing');

      const adminId = Number(req.user.tg_id);
      const specs = [
        { tg_id: DEMO_IDS[0], level: 1, referrer_id: adminId, first_name: 'Demo L1', username: 'demo_l1', amount: 100 },
        { tg_id: DEMO_IDS[1], level: 2, referrer_id: DEMO_IDS[0], first_name: 'Demo L2', username: 'demo_l2', amount: 300 },
        { tg_id: DEMO_IDS[2], level: 3, referrer_id: DEMO_IDS[1], first_name: 'Demo L3', username: 'demo_l3', amount: 1000 },
      ];

      let createdOrders = 0;
      let createdAccruals = 0;
      for (const spec of specs) {
        db.createUser({
          tg_id: spec.tg_id,
          first_name: spec.first_name,
          username: spec.username,
          referrer_id: spec.referrer_id,
          code: db.generateCode(),
        });
        const past = new Date(Date.now() - 3600 * 1000);
        const info = db.run(
          `INSERT INTO orders (user_id, plan_id, amount, rate, status, created_at, activated_at, completes_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
          spec.tg_id,
          plan.id,
          round2(spec.amount),
          Number(plan.rate_hi),
          isoIn(-2 * 3600 * 1000, past),
          isoIn(-2 * 3600 * 1000, past),
          isoIn(-30 * 60 * 1000),
        );
        createdOrders += 1;
        const result = orders.completeOrder(info.lastInsertRowid, { reviewedBy: adminId });
        if (result.ok) createdAccruals += result.accruals.length;
      }
      audit(req, 'seed-demo', { admin: adminId, users: DEMO_IDS.length });
      return { ok: true, created: { users: DEMO_IDS.length, orders: createdOrders, accruals: createdAccruals } };
    }),
  );

  return router;
}

/* -------------------------------------------------------------------------- */
/* app assembly                                                                */
/* -------------------------------------------------------------------------- */

function notFound(req, res, next) {
  next(httpError(404, 'not_found'));
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }
  // body-parser errors (malformed JSON, too large payload)
  if (error && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
    const message = error.type === 'entity.too.large' ? 'payload_too_large' : 'invalid_json';
    res.status(400).json({ error: message });
    return;
  }
  const status = Number.isInteger(error && error.status) && error.status >= 400 ? error.status : 500;
  if (status >= 500) {
    console.error('[arvex] request failed', req.method, req.originalUrl, (error && error.stack) || error);
  }
  const payload = { error: status >= 500 ? 'internal_error' : String((error && error.message) || 'error') };
  if (error && typeof error === 'object') {
    for (const key of ['banned', 'available', 'source', 'allowed', 'min_amount', 'max_amount', 'rate_lo', 'rate_hi']) {
      if (error[key] !== undefined) payload[key] = error[key];
    }
  }
  res.status(status).json(payload);
}

/** Mount the API, the static site and the error handling on an Express app. */
function mount(app) {
  app.use(createRouter());

  // pages
  app.get('/', (req, res) => {
    const file = path.join(config.PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: 'index.html_missing' });
      return;
    }
    res.sendFile(file);
  });
  app.get('/admin', (req, res) => {
    const file = path.join(config.PUBLIC_DIR, 'admin.html');
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: 'admin.html_missing' });
      return;
    }
    res.sendFile(file);
  });

  // /assets/*, favicon, …
  app.use(express.static(config.PUBLIC_DIR, { index: false, maxAge: '2m' }));

  // unknown /api/* → JSON 404
  app.use('/api', notFound);
  app.use(notFound);

  app.use(errorHandler);
}

module.exports = {
  createRouter,
  mount,
  requireUser,
  requireAdmin,
  referralStats,
  errorHandler,
  notFound,
};
