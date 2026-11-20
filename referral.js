'use strict';

/**
 * ARVEX order + referral service.
 *
 * Contains the exact upline-walk accrual algorithm and the order-completion
 * routine from API.md, plus `tick()` which completes due orders (run every 20s
 * and on every `/api/me` read).
 *
 * Idempotency: completion is gated by a single
 *   UPDATE orders SET status='completed' … WHERE id=? AND status='active'
 * whose `changes === 1` authorises the accrual write, so two concurrent ticks
 * can never double-credit anyone.
 */

const db = require('./db');
const { httpError } = require('./auth');

const MAX_LEVEL = 3;
const MAX_HOPS = 50; // cycle safety while walking the upline

/* -------------------------------------------------------------------------- */
/* views                                                                       */
/* -------------------------------------------------------------------------- */

/** Canonical order object returned by the API. */
function orderView(order, extra = {}) {
  if (!order) return null;
  return {
    id: Number(order.id),
    user_id: order.user_id === undefined || order.user_id === null ? undefined : Number(order.user_id),
    user_name: order.user_name === undefined ? undefined : order.user_name,
    user_tg_id: order.user_tg_id === undefined || order.user_tg_id === null ? undefined : Number(order.user_tg_id),
    plan_id: order.plan_id,
    plan_name: order.plan_name === undefined ? undefined : order.plan_name,
    amount: db.round2(order.amount),
    rate: Number(order.rate),
    status: order.status,
    created_at: order.created_at,
    activated_at: order.activated_at === undefined ? null : order.activated_at,
    completes_at: order.completes_at === undefined ? null : order.completes_at,
    profit: order.profit === null || order.profit === undefined ? null : db.round2(order.profit),
    completed_at: order.completed_at === undefined ? null : order.completed_at,
    reviewed_by: order.reviewed_by === undefined || order.reviewed_by === null ? null : Number(order.reviewed_by),
    note: order.note === undefined ? null : order.note,
    ...extra,
  };
}

function getOrder(orderId) {
  return db.get('SELECT * FROM orders WHERE id = ?', Number(orderId));
}

function getOrderDetailed(orderId) {
  return db.get(
    `SELECT o.*, p.name AS plan_name, u.first_name AS user_name, u.tg_id AS user_tg_id
       FROM orders o
       LEFT JOIN plans p ON p.id = o.plan_id
       LEFT JOIN users u ON u.tg_id = o.user_id
      WHERE o.id = ?`,
    Number(orderId),
  );
}

/* -------------------------------------------------------------------------- */
/* creation                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/orders validation + insert (API.md business rule 3).
 * Never trusts the client: the plan row is loaded from the DB and every bound
 * value is validated first.
 */
function createOrder({ userId, planId, amount, rate }) {
  const plan = db.getPlan(planId);
  if (!plan) throw httpError(400, 'unknown_plan');
  if (Number(plan.enabled) !== 1) throw httpError(400, 'plan_disabled');

  const value = Number(amount);
  if (!Number.isFinite(value)) throw httpError(400, 'invalid_amount');
  if (db.round2(value) <= 0) throw httpError(400, 'invalid_amount');
  const min = Number(plan.min_amount);
  const max = Number(plan.max_amount);
  if (value < min || value > max) {
    throw httpError(400, 'amount_out_of_range', { min_amount: min, max_amount: max });
  }

  const chosen = Number(rate);
  if (!Number.isFinite(chosen)) throw httpError(400, 'invalid_rate');
  const lo = Number(plan.rate_lo);
  const hi = Number(plan.rate_hi);
  if (chosen < lo || chosen > hi) {
    throw httpError(400, 'rate_out_of_range', { rate_lo: lo, rate_hi: hi });
  }

  const now = new Date();
  const auto = db.autoApproveOrders();
  const status = auto ? 'active' : 'pending';
  const info = db.run(
    `INSERT INTO orders (user_id, plan_id, amount, rate, status, created_at, activated_at, completes_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    Number(userId),
    String(plan.id),
    db.round2(value),
    chosen,
    status,
    db.nowIso(now),
    auto ? db.nowIso(now) : null,
    auto ? db.isoIn(Number(plan.period_hours) * 3600 * 1000, now) : null,
  );
  return getOrderDetailed(info.lastInsertRowid);
}

/* -------------------------------------------------------------------------- */
/* accrual — exact upline walk from API.md                                     */
/* -------------------------------------------------------------------------- */

/**
 * Walk the upline chain of `owner` (3 levels max, 50 hops cap) crediting
 * `round2(profit * rate_level)` to every ancestor and inserting one accruals
 * row per ancestor.
 */
function accrueUpline({ order, owner, profit, rates }) {
  const rows = [];
  let node = owner;
  let level = 1;
  let hops = 0;
  const visited = new Set([Number(owner.tg_id)]);

  while (node && node.referrer_id !== null && node.referrer_id !== undefined && level <= MAX_LEVEL && hops < MAX_HOPS) {
    const parent = db.getUser(node.referrer_id);
    if (!parent) break;
    if (visited.has(Number(parent.tg_id))) break; // cycle guard
    visited.add(Number(parent.tg_id));

    const rate = Number(rates[`l${level}`]);
    const amount = db.round2(profit * rate);
    db.creditReferrer(parent.tg_id, amount);
    db.run(
      `INSERT INTO accruals (user_id, order_id, level, from_user_id, base_profit, rate, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      Number(parent.tg_id),
      Number(order.id),
      level,
      Number(owner.tg_id),
      db.round2(profit),
      rate,
      amount,
      db.nowIso(),
    );
    rows.push({ user_id: Number(parent.tg_id), level, rate, amount });

    node = parent;
    level += 1;
    hops += 1;
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* completion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Complete one `active` order: profit = round2(amount * rate),
 * balance += amount + profit, total_profit += profit, then the upline accruals.
 *
 * Returns `{ ok:true, order, accruals }` or `{ ok:false, reason, order }`.
 */
function completeOrder(orderId, { reviewedBy = null } = {}) {
  const id = Number(orderId);
  const order = getOrder(id);
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.status !== 'active') return { ok: false, reason: 'not_active', order: getOrderDetailed(id) };

  const profit = db.round2(Number(order.amount) * Number(order.rate));
  const now = db.nowIso();
  const reviewer = reviewedBy === null || reviewedBy === undefined ? null : Number(reviewedBy);

  const result = db.transaction(() => {
    // the idempotency gate — only one caller may flip active → completed
    const gate = db.run(
      `UPDATE orders
          SET status = 'completed', completed_at = ?, profit = ?, reviewed_by = COALESCE(?, reviewed_by)
        WHERE id = ? AND status = 'active'`,
      now,
      profit,
      reviewer,
      id,
    );
    if (gate.changes !== 1) return { gated: false };

    const owner = db.getUser(order.user_id);
    if (!owner) throw httpError(500, 'order_owner_missing');
    db.creditOwner(owner.tg_id, Number(order.amount), profit);

    let accruals = [];
    if (db.referralEnabled()) {
      accruals = accrueUpline({ order, owner, profit, rates: db.getRates() });
    }
    return { gated: true, accruals };
  });

  if (!result.gated) return { ok: false, reason: 'already_completed', order: getOrderDetailed(id) };
  return { ok: true, order: getOrderDetailed(id), accruals: result.accruals };
}

/** Admin approve: pending → active (+ completes_at from the plan period). */
function activateOrder(orderId, reviewedBy) {
  const id = Number(orderId);
  const order = getOrder(id);
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.status !== 'pending') return { ok: false, reason: 'not_pending', order: getOrderDetailed(id) };
  const plan = db.getPlan(order.plan_id);
  const now = new Date();
  db.run(
    `UPDATE orders
        SET status = 'active', activated_at = ?, completes_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'pending'`,
    db.nowIso(now),
    db.isoIn(Number(plan ? plan.period_hours : 24) * 3600 * 1000, now),
    Number(reviewedBy),
    id,
  );
  return { ok: true, order: getOrderDetailed(id) };
}

/** Admin reject: pending → rejected. */
function rejectOrder(orderId, reviewedBy, note = null) {
  const id = Number(orderId);
  const order = getOrder(id);
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.status !== 'pending') return { ok: false, reason: 'not_pending', order: getOrderDetailed(id) };
  db.run(
    `UPDATE orders SET status = 'rejected', reviewed_by = ?, note = ? WHERE id = ? AND status = 'pending'`,
    Number(reviewedBy),
    note === null || note === undefined ? null : String(note).slice(0, 255),
    id,
  );
  return { ok: true, order: getOrderDetailed(id) };
}

/**
 * Complete every active order whose `completes_at` has come.
 * Returns the number of orders completed.
 */
function tick() {
  const now = db.nowIso();
  const due = db.all(
    "SELECT id FROM orders WHERE status = 'active' AND completes_at IS NOT NULL AND completes_at <= ? ORDER BY completes_at ASC, id ASC",
    now,
  );
  let completed = 0;
  for (const row of due) {
    try {
      const result = completeOrder(row.id);
      if (result.ok) completed += 1;
    } catch (error) {
      console.error('[arvex] tick failed for order', row.id, error && error.message);
    }
  }
  return completed;
}

module.exports = {
  MAX_LEVEL,
  MAX_HOPS,
  orderView,
  getOrder,
  getOrderDetailed,
  createOrder,
  accrueUpline,
  completeOrder,
  activateOrder,
  rejectOrder,
  tick,
};
