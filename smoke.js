'use strict';

/**
 * ARVEX smoke test — `npm run smoke`.
 *
 * Self-contained: a temporary SQLite file (DATABASE_FILE), an ephemeral port
 * (PORT=0) and insecure/dev auth. No network access required, no fixtures.
 *
 * Covers: health/config, dev auth, referral tree linking, order validation,
 * auto-approve, force-complete owner credit, the exact L1/L2/L3 accrual rows,
 * double-completion, admin ACLs, root immutability, plan + settings updates,
 * withdrawals, overview totals, seed-demo and the JSON 404.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* -------------------------------------------------------------------------- */
/* environment — must be set before the app modules are loaded                 */
/* -------------------------------------------------------------------------- */

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arvex-smoke-'));
process.env.DATABASE_FILE = path.join(TMP_DIR, 'smoke.sqlite');
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.BOT_TOKEN = ''; // → insecure mode
process.env.ROOT_ADMIN_ID = '111';
process.env.AUTO_APPROVE_ORDERS = '1';
process.env.SESSION_TTL_HOURS = '720';
process.env.INVITE_BOT_USERNAME = 'arvex_smoke_bot';

const db = require('./db');
const { start } = require('./index.js');

const ROOT_ID = 111;
const USER_A = 1001;
const USER_B = 1002;
const USER_C = 1003;
const USER_D = 1004;
const ADMIN2 = 2001;
const ADMIN3 = 2002;

const money = (value) => Number(Number(value).toFixed(2));

/* -------------------------------------------------------------------------- */
/* tiny sequential test runner                                                 */
/* -------------------------------------------------------------------------- */

const results = [];
let BASE = '';

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${(error && error.message ? error.message : String(error)).split('\n').join('\n      ')}`);
  }
}

async function api(method, route, { token, body, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + route, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (!raw && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text };
}

const get = (route, token) => api('GET', route, { token });
const post = (route, body, token) => api('POST', route, { body, token });
const put = (route, body, token) => api('PUT', route, { body, token });

async function login(tgId, devName, startparam) {
  const payload = { devTgId: String(tgId), devName };
  if (startparam) payload.startparam = startparam;
  const response = await post('/api/auth', payload);
  assert.equal(response.status, 200, `auth ${tgId} → ${response.status} ${response.text}`);
  assert.ok(response.json && response.json.token, `auth ${tgId} returned no token`);
  return response.json;
}

function assertUserShape(user, label) {
  for (const key of ['tg_id', 'code', 'first_name', 'username', 'balance', 'ref_balance', 'total_profit', 'total_ref', 'is_admin', 'is_root', 'banned', 'referrer']) {
    assert.ok(Object.prototype.hasOwnProperty.call(user, key), `${label}: user.${key} missing`);
  }
}

/* -------------------------------------------------------------------------- */
/* the test plan                                                               */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log('\nARVEX smoke test');
  console.log(`  db   : ${process.env.DATABASE_FILE}`);
  console.log(`  mode : insecure (no BOT_TOKEN), root admin ${ROOT_ID}`);

  const server = await start({ port: 0, host: '127.0.0.1' });
  BASE = `http://127.0.0.1:${server.port}`;
  console.log(`  url  : ${BASE}\n`);

  let rootToken = '';
  let tokenA = '';
  let tokenB = '';
  let tokenC = '';
  let tokenD = '';
  let codeA = '';
  let codeB = '';
  let codeC = '';
  let demoOrderId = 0;
  let withdrawalId = 0;
  let secondToken = '';

  await step('GET /api/health reports insecure mode', async () => {
    const response = await get('/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, mode: 'insecure' });
  });

  await step('GET /api/config exposes the seeded plans, rates and flags', async () => {
    const response = await get('/api/config');
    assert.equal(response.status, 200);
    const config = response.json;
    assert.deepEqual(config.plans.map((plan) => plan.id), ['start', 'standard', 'advanced', 'vip']);
    assert.deepEqual(config.plans[0], {
      id: 'start',
      name: 'START',
      min_amount: 25,
      max_amount: 1500,
      rate_lo: 0.25,
      rate_hi: 0.27,
      period_hours: 24,
      enabled: true,
    });
    assert.deepEqual(config.rates, { l1: 0.1, l2: 0.07, l3: 0.05 });
    assert.equal(config.referral_enabled, true);
    assert.equal(config.auto_approve_orders, true);
    assert.equal(config.bot_username, 'arvex_smoke_bot');
    assert.equal(config.root_admin_configured, true);
  });

  await step('POST /api/auth accepts devTgId in insecure mode (root admin)', async () => {
    const response = await post('/api/auth', { devTgId: '111', devName: 'Root Admin' });
    assert.equal(response.status, 200);
    assert.match(response.json.token, /^[0-9a-f]{64}$/);
    assertUserShape(response.json.user, 'auth');
    assert.equal(response.json.user.tg_id, ROOT_ID);
    assert.equal(response.json.user.is_admin, true);
    assert.equal(response.json.user.is_root, true);
    assert.equal(response.json.user.banned, false);
    rootToken = response.json.token;
  });

  await step('user endpoints without a token → 401 unauthorized', async () => {
    const response = await get('/api/me');
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, { error: 'unauthorized' });
  });

  await step('user A registers and gets a referral code', async () => {
    const result = await login(USER_A, 'Alice');
    assertUserShape(result.user, 'A');
    assert.match(result.user.code, /^[a-z0-9]{6,10}$/);
    assert.equal(result.user.referrer, null);
    tokenA = result.token;
    codeA = result.user.code;
  });

  await step('user B registers through ref_<code> and links under A', async () => {
    const result = await login(USER_B, 'Bob', `ref_${codeA}`);
    assert.equal(result.user.referrer && result.user.referrer.tg_id, USER_A);
    assert.equal(result.user.referrer.code, codeA);
    tokenB = result.token;
    codeB = result.user.code;
    const me = await get('/api/me', tokenB);
    assert.equal(me.status, 200);
    assert.equal(me.json.user.referrer.tg_id, USER_A);
    assert.deepEqual(me.json.stats.partners, { l1: 0, l2: 0, l3: 0, total: 0 });
  });

  await step('users C and D complete a 3-level chain (A→B→C→D)', async () => {
    const c = await login(USER_C, 'Cara', `ref_${codeB}`);
    assert.equal(c.user.referrer.tg_id, USER_B);
    tokenC = c.token;
    codeC = c.user.code;
    const d = await login(USER_D, 'Dan', `ref_${codeC}`);
    assert.equal(d.user.referrer.tg_id, USER_C);
    tokenD = d.token;
    // the tree is never rewritten by a later auth with another code
    const relink = await login(USER_D, 'Dan', `ref_${codeA}`);
    assert.equal(relink.user.referrer.tg_id, USER_C);
    // A now sees 1/1/1 partners
    const meA = await get('/api/me', tokenA);
    assert.deepEqual(meA.json.stats.partners, { l1: 1, l2: 1, l3: 1, total: 3 });
  });

  await step('order validation: amount below plan min → 400', async () => {
    const response = await post('/api/orders', { plan_id: 'start', amount: 10, rate: 0.27 }, tokenD);
    assert.equal(response.status, 400);
    assert.equal(response.json.error, 'amount_out_of_range');
  });

  await step('order validation: rate outside plan range → 400', async () => {
    const response = await post('/api/orders', { plan_id: 'start', amount: 100, rate: 0.9 }, tokenD);
    assert.equal(response.status, 400);
    assert.equal(response.json.error, 'rate_out_of_range');
  });

  await step('order validation: unknown plan / bad payload → 400', async () => {
    const unknown = await post('/api/orders', { plan_id: 'nope', amount: 100, rate: 0.27 }, tokenD);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error, 'unknown_plan');
    const bad = await post('/api/orders', { plan_id: 'start', amount: 'abc', rate: 0.27 }, tokenD);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_amount');
    const broken = await api('POST', '/api/orders', { token: tokenD, body: '{not json' });
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error, 'invalid_json');
  });

  await step('auto-approve creates an active order with completes_at', async () => {
    const response = await post('/api/orders', { plan_id: 'start', amount: 100, rate: 0.27 }, tokenD);
    assert.equal(response.status, 200);
    const order = response.json.order;
    demoOrderId = order.id;
    assert.equal(order.status, 'active');
    assert.equal(order.amount, 100);
    assert.equal(order.rate, 0.27);
    assert.equal(order.plan_name, 'START');
    assert.ok(order.activated_at, 'activated_at must be set');
    assert.ok(order.completes_at, 'completes_at must be set');
    assert.equal(Date.parse(order.completes_at) - Date.parse(order.created_at), 24 * 3600 * 1000);
    assert.equal(order.profit, null);
    const mine = await get('/api/orders', tokenD);
    assert.equal(mine.json.orders.length, 1);
  });

  await step('admin-only endpoints return 403 for a normal user', async () => {
    for (const route of ['/api/admin/overview', '/api/admin/users', '/api/admin/settings', '/api/admin/plans', '/api/admin/admins']) {
      const response = await get(route, tokenA);
      assert.equal(response.status, 403, `${route} → ${response.status}`);
      assert.deepEqual(response.json, { error: 'forbidden' });
    }
    const denied = await post(`/api/admin/orders/${demoOrderId}/complete`, {}, tokenA);
    assert.equal(denied.status, 403);
  });

  await step('admin force-complete credits amount + profit to the owner', async () => {
    const response = await post(`/api/admin/orders/${demoOrderId}/complete`, {}, rootToken);
    assert.equal(response.status, 200);
    const order = response.json.order;
    assert.equal(order.status, 'completed');
    assert.equal(money(order.profit), 27, 'profit must be 100 * 0.27 = 27');
    assert.ok(order.completed_at);
    assert.equal(order.reviewed_by, ROOT_ID, 'reviewed_by must record the acting admin');

    const me = await get('/api/me', tokenD);
    assert.equal(money(me.json.user.balance), 127, 'balance must be amount + profit');
    assert.equal(money(me.json.user.total_profit), 27);
    assert.equal(money(me.json.user.ref_balance), 0);
  });

  await step('completion produces EXACTLY the L1 10% / L2 7% / L3 5% accruals', async () => {
    const response = await get('/api/admin/accruals?limit=500', rootToken);
    assert.equal(response.status, 200);
    const rows = response.json.accruals.filter((row) => row.order_id === demoOrderId);
    assert.equal(rows.length, 3, `expected exactly 3 accrual rows, got ${rows.length}`);
    const byLevel = rows.sort((a, b) => a.level - b.level);
    assert.deepEqual(
      byLevel.map((row) => [row.level, row.rate, money(row.amount), row.user_id, row.from_user_id, money(row.base_profit)]),
      [
        [1, 0.1, 2.7, USER_C, USER_D, 27], // 27 * 10% = 2.70 → direct inviter
        [2, 0.07, 1.89, USER_B, USER_D, 27], // 27 * 7%  = 1.89 → second line
        [3, 0.05, 1.35, USER_A, USER_D, 27], // 27 * 5%  = 1.35 → third line
      ],
    );
    assert.deepEqual(
      byLevel.map((row) => row.from_name),
      ['Dan', 'Dan', 'Dan'],
    );

    for (const [token, expected] of [[tokenC, 2.7], [tokenB, 1.89], [tokenA, 1.35]]) {
      const me = await get('/api/me', token);
      assert.equal(money(me.json.user.ref_balance), expected, `ref_balance of ${me.json.user.first_name}`);
      assert.equal(money(me.json.user.total_ref), expected);
      assert.equal(money(me.json.user.balance), 0, 'referral credit must not touch the deposit balance');
    }
  });

  await step('double-complete is impossible (no double credit)', async () => {
    const again = await post(`/api/admin/orders/${demoOrderId}/complete`, {}, rootToken);
    assert.equal(again.status, 409);
    assert.ok(['not_active', 'already_completed'].includes(again.json.error), `unexpected error ${again.json.error}`);
    const me = await get('/api/me', tokenD);
    assert.equal(money(me.json.user.balance), 127, 'balance must not change');
    assert.equal(money(me.json.user.total_profit), 27);
    const accruals = await get('/api/admin/accruals?limit=500', rootToken);
    assert.equal(accruals.json.accruals.filter((row) => row.order_id === demoOrderId).length, 3);
    const c = await get('/api/me', tokenC);
    assert.equal(money(c.json.user.ref_balance), 2.7);
  });

  await step('GET /api/referral computes levels[] aggregates from real rows', async () => {
    const response = await get('/api/referral', tokenA);
    assert.equal(response.status, 200);
    const data = response.json;
    assert.equal(data.code, codeA);
    assert.equal(data.link, `https://t.me/arvex_smoke_bot?start=ref_${codeA}`);
    assert.deepEqual(data.rates, { l1: 0.1, l2: 0.07, l3: 0.05 });
    assert.equal(money(data.ref_balance), 1.35);
    assert.equal(money(data.total_ref), 1.35);
    assert.equal(data.enabled, true);
    assert.deepEqual(data.levels, [
      { level: 1, rate: 0.1, partners: 1, profit: 0, earned: 0 },
      { level: 2, rate: 0.07, partners: 1, profit: 0, earned: 0 },
      { level: 3, rate: 0.05, partners: 1, profit: 27, earned: 1.35 },
    ]);
    assert.equal(data.accruals.length, 1);
    assert.deepEqual(
      { ...data.accruals[0], amount: money(data.accruals[0].amount), base_profit: money(data.accruals[0].base_profit) },
      {
        id: data.accruals[0].id,
        level: 3,
        from_name: 'Dan',
        from_username: null,
        base_profit: 27,
        rate: 0.05,
        amount: 1.35,
        created_at: data.accruals[0].created_at,
      },
    );
    assert.deepEqual(data.partners.map((partner) => [partner.level, partner.tg_id, partner.first_name]), [
      [1, USER_B, 'Bob'],
      [2, USER_C, 'Cara'],
      [3, USER_D, 'Dan'],
    ]);
    assert.equal(money(data.partners[2].profit), 27);
    assert.equal(money(data.partners[2].earned), 1.35);
    for (const partner of data.partners) assert.ok(partner.joined_at, 'joined_at must be set');
  });

  await step('a banned user gets 403 on user endpoints', async () => {
    const ban = await post(`/api/admin/users/${USER_D}/ban`, { banned: true }, rootToken);
    assert.equal(ban.status, 200);
    assert.equal(ban.json.ok, true);
    for (const route of ['/api/me', '/api/orders', '/api/referral', '/api/withdrawals']) {
      const response = await get(route, tokenD);
      assert.equal(response.status, 403, `${route} → ${response.status}`);
      assert.equal(response.json.error, 'forbidden');
      assert.equal(response.json.banned, true);
    }
    const blocked = await post('/api/orders', { plan_id: 'start', amount: 100, rate: 0.27 }, tokenD);
    assert.equal(blocked.status, 403);
    const unban = await post(`/api/admin/users/${USER_D}/ban`, { banned: false }, rootToken);
    assert.equal(unban.status, 200);
    const me = await get('/api/me', tokenD);
    assert.equal(me.status, 200);
    assert.equal(me.json.user.banned, false);
  });

  await step('root appoints an admin; a non-root admin cannot add admins', async () => {
    const added = await post('/api/admin/admins', { tg_id: ADMIN2, first_name: 'Second Admin' }, rootToken);
    assert.equal(added.status, 200);
    assert.equal(added.json.admin.tg_id, ADMIN2);
    assert.equal(added.json.admin.is_root, false);
    assert.equal(added.json.admin.added_by, ROOT_ID, 'added_by must record the acting root');

    const second = await login(ADMIN2, 'Second Admin');
    assert.equal(second.user.is_admin, true);
    assert.equal(second.user.is_root, false);
    secondToken = second.token;

    const denied = await post('/api/admin/admins', { tg_id: ADMIN3 }, second.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'root_only');

    // other admin sections stay open for non-root admins
    for (const route of ['/api/admin/overview', '/api/admin/users', '/api/admin/orders', '/api/admin/accruals', '/api/admin/settings']) {
      const response = await get(route, second.token);
      assert.equal(response.status, 200, `${route} → ${response.status}`);
    }
  });

  await step('duplicate admin → 409; the root admin cannot be revoked or banned', async () => {
    const duplicate = await post('/api/admin/admins', { tg_id: ADMIN2 }, rootToken);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error, 'already_admin');

    const selfRevoke = await post(`/api/admin/admins/${ROOT_ID}/revoke`, {}, rootToken);
    assert.equal(selfRevoke.status, 409);
    assert.equal(selfRevoke.json.error, 'root_immutable');

    const second = secondToken;
    const foreignRevoke = await post(`/api/admin/admins/${ROOT_ID}/revoke`, {}, second);
    assert.equal(foreignRevoke.status, 403);

    const banRoot = await post(`/api/admin/users/${ROOT_ID}/ban`, { banned: true }, rootToken);
    assert.equal(banRoot.status, 403);
    assert.equal(banRoot.json.error, 'root_immutable');

    const list = await get('/api/admin/admins', rootToken);
    assert.equal(list.status, 200);
    assert.equal(list.json.root_id, ROOT_ID);
    assert.equal(list.json.can_manage, true);
    assert.deepEqual(list.json.admins.map((admin) => [admin.tg_id, admin.is_root]), [[ROOT_ID, true], [ADMIN2, false]]);
    const foreign = await get('/api/admin/admins', second);
    assert.equal(foreign.json.can_manage, false);

    // a non-root admin can be revoked by root
    const third = await post('/api/admin/admins', { tg_id: ADMIN3 }, rootToken);
    assert.equal(third.status, 200);
    const revoked = await post(`/api/admin/admins/${ADMIN3}/revoke`, {}, rootToken);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.ok, true);
    const revokedAgain = await post(`/api/admin/admins/${ADMIN3}/revoke`, {}, rootToken);
    assert.equal(revokedAgain.status, 404);
    assert.equal(db.isRoot(ADMIN2), false);
  });

  await step('admin user search, detail, balance and re-parent work', async () => {
    const search = await get(`/api/admin/users?q=${codeA}&limit=10&offset=0`, rootToken);
    assert.equal(search.status, 200);
    assert.equal(search.json.total, 1);
    assert.equal(search.json.users[0].tg_id, USER_A);
    assert.equal(search.json.users[0].referrer_name, null);
    assert.equal(typeof search.json.users[0].orders, 'number');

    const detail = await get(`/api/admin/users/${USER_A}`, rootToken);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.user.tg_id, USER_A);
    assert.deepEqual(Object.keys(detail.json.tree), ['l1', 'l2', 'l3']);
    assert.deepEqual(detail.json.tree.l1.map((row) => row.tg_id), [USER_B]);
    assert.deepEqual(detail.json.tree.l2.map((row) => row.tg_id), [USER_C]);
    assert.deepEqual(detail.json.tree.l3.map((row) => row.tg_id), [USER_D]);
    assert.equal(detail.json.parent, null);
    assert.equal(detail.json.accruals.length, 1);
    assert.equal(detail.json.orders.length, 0);

    const balance = await post(`/api/admin/users/${USER_B}/balance`, { amount: 50, source: 'deposit', note: 'manual' }, rootToken);
    assert.equal(balance.status, 200);
    assert.equal(money(balance.json.balance), 50);
    const negative = await post(`/api/admin/users/${USER_B}/balance`, { amount: -20, source: 'deposit' }, rootToken);
    assert.equal(money(negative.json.balance), 30);
    const refAdjust = await post(`/api/admin/users/${USER_B}/balance`, { amount: 10, source: 'ref' }, rootToken);
    assert.equal(money(refAdjust.json.ref_balance), 11.89);

    // re-parenting: D under A must be rejected (would create a cycle), B under A stays
    const cycle = await post(`/api/admin/users/${USER_A}/parent`, { parent_id: USER_D }, rootToken);
    assert.equal(cycle.status, 400);
    assert.equal(cycle.json.error, 'cycle_not_allowed');
    const self = await post(`/api/admin/users/${USER_A}/parent`, { parent_id: USER_A }, rootToken);
    assert.equal(self.status, 400);
    const missing = await post(`/api/admin/users/${USER_A}/parent`, { parent_id: 999999 }, rootToken);
    assert.equal(missing.status, 404);
    const moved = await post(`/api/admin/users/${USER_D}/parent`, { parent_id: USER_A }, rootToken);
    assert.equal(moved.status, 200);
    assert.equal(moved.json.parent_id, USER_A);
    const movedBack = await post(`/api/admin/users/${USER_D}/parent`, { parent_id: USER_C }, rootToken);
    assert.equal(movedBack.status, 200);
    const badId = await get('/api/admin/users/not-a-number', rootToken);
    assert.equal(badId.status, 400);
  });

  await step('plan update works (and is validated)', async () => {
    const updated = await put('/api/admin/plans/start', { min_amount: 30, rate_hi: 0.28, enabled: true }, rootToken);
    assert.equal(updated.status, 200);
    assert.equal(money(updated.json.plan.min_amount), 30);
    assert.equal(updated.json.plan.rate_hi, 0.28);
    const config = await get('/api/config');
    assert.equal(money(config.json.plans[0].min_amount), 30);
    assert.equal(config.json.plans[0].rate_hi, 0.28);

    const badRange = await put('/api/admin/plans/start', { min_amount: 9000, max_amount: 10 }, rootToken);
    assert.equal(badRange.status, 400);
    assert.equal(badRange.json.error, 'invalid_amount_range');
    const badRate = await put('/api/admin/plans/start', { rate_lo: 0.5, rate_hi: 0.2 }, rootToken);
    assert.equal(badRate.status, 400);
    assert.equal(badRate.json.error, 'invalid_rate_range');
    const missing = await put('/api/admin/plans/nope', { name: 'X' }, rootToken);
    assert.equal(missing.status, 404);
    const forbidden = await put('/api/admin/plans/start', { name: 'X' }, tokenB);
    assert.equal(forbidden.status, 403);

    const restored = await put('/api/admin/plans/start', { min_amount: 25, rate_hi: 0.27 }, rootToken);
    assert.equal(money(restored.json.plan.min_amount), 25);
    const plans = await get('/api/admin/plans', rootToken);
    assert.equal(plans.json.plans.length, 4);
  });

  await step('settings update works', async () => {
    const before = await get('/api/admin/settings', rootToken);
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.settings, {
      rate_l1: 0.1,
      rate_l2: 0.07,
      rate_l3: 0.05,
      auto_approve_orders: true,
      referral_enabled: true,
    });

    const updated = await put('/api/admin/settings', { rate_l1: 0.12, auto_approve_orders: false, referral_enabled: false }, rootToken);
    assert.equal(updated.status, 200);
    assert.equal(updated.json.settings.rate_l1, 0.12);
    assert.equal(updated.json.settings.auto_approve_orders, false);
    assert.equal(updated.json.settings.referral_enabled, false);
    const config = await get('/api/config');
    assert.equal(config.json.rates.l1, 0.12);
    assert.equal(config.json.auto_approve_orders, false);
    assert.equal(config.json.referral_enabled, false);

    const bad = await put('/api/admin/settings', { rate_l2: 5 }, rootToken);
    assert.equal(bad.status, 400);
    const forbidden = await put('/api/admin/settings', { rate_l1: 0.5 }, tokenB);
    assert.equal(forbidden.status, 403);

    const restored = await put('/api/admin/settings', { rate_l1: 0.1, auto_approve_orders: true, referral_enabled: true }, rootToken);
    assert.deepEqual(restored.json.settings, {
      rate_l1: 0.1,
      rate_l2: 0.07,
      rate_l3: 0.05,
      auto_approve_orders: true,
      referral_enabled: true,
    });
  });

  await step('withdrawal over-balance is rejected', async () => {
    const over = await post('/api/withdrawals', { amount: 500, source: 'deposit' }, tokenD);
    assert.equal(over.status, 400);
    assert.equal(over.json.error, 'insufficient_balance');
    assert.equal(money(over.json.available), 127);
    const overRef = await post('/api/withdrawals', { amount: 10, source: 'ref' }, tokenD);
    assert.equal(overRef.status, 400);
    const zero = await post('/api/withdrawals', { amount: 0, source: 'deposit' }, tokenD);
    assert.equal(zero.status, 400);
    const badSource = await post('/api/withdrawals', { amount: 10, source: 'gold' }, tokenD);
    assert.equal(badSource.status, 400);
  });

  await step('withdrawal approval deducts the balance', async () => {
    const created = await post('/api/withdrawals', { amount: 27, source: 'deposit' }, tokenD);
    assert.equal(created.status, 200);
    withdrawalId = created.json.withdrawal.id;
    assert.equal(created.json.withdrawal.status, 'pending');
    assert.equal(money(created.json.withdrawal.amount), 27);

    const mine = await get('/api/withdrawals', tokenD);
    assert.equal(mine.json.withdrawals.length, 1);

    const pending = await get('/api/admin/withdrawals?status=pending', rootToken);
    assert.ok(pending.json.withdrawals.some((row) => row.id === withdrawalId && row.user_name === 'Dan'));

    const approved = await post(`/api/admin/withdrawals/${withdrawalId}/approve`, {}, rootToken);
    assert.equal(approved.status, 200);
    assert.equal(approved.json.withdrawal.status, 'approved');
    assert.equal(approved.json.withdrawal.reviewed_by, ROOT_ID);
    assert.ok(approved.json.withdrawal.reviewed_at);

    const me = await get('/api/me', tokenD);
    assert.equal(money(me.json.user.balance), 100, 'approval must deduct the amount');
    assert.equal(money(me.json.user.ref_balance), 0, 'deposit source must not touch ref_balance');

    const twice = await post(`/api/admin/withdrawals/${withdrawalId}/approve`, {}, rootToken);
    assert.equal(twice.status, 409);
  });

  await step('withdrawal rejection keeps the balance', async () => {
    const created = await post('/api/withdrawals', { amount: 5, source: 'deposit' }, tokenD);
    const id = created.json.withdrawal.id;
    const rejected = await post(`/api/admin/withdrawals/${id}/reject`, { note: 'wrong wallet' }, rootToken);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.json.withdrawal.status, 'rejected');
    assert.equal(rejected.json.withdrawal.note, 'wrong wallet');
    const me = await get('/api/me', tokenD);
    assert.equal(money(me.json.user.balance), 100);
  });

  await step('admin overview totals and by_day come from real rows', async () => {
    const response = await get('/api/admin/overview', rootToken);
    assert.equal(response.status, 200);
    const { totals, by_day, recent_orders, recent_accruals } = response.json;
    assert.ok(totals.users >= 6, `users=${totals.users}`);
    assert.equal(totals.orders_pending, 0);
    assert.equal(totals.orders_active, 0);
    assert.equal(totals.orders_completed, 1);
    assert.equal(money(totals.deposits_volume), 100);
    assert.equal(money(totals.profit_paid), 27);
    assert.equal(money(totals.ref_paid), 5.94); // 2.70 + 1.89 + 1.35
    assert.equal(totals.withdrawals_pending, 0);
    assert.ok(Array.isArray(by_day) && by_day.length >= 1);
    assert.ok(by_day.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)), 'by_day dates must be YYYY-MM-DD');
    const summed = by_day.reduce(
      (acc, day) => ({
        orders: acc.orders + day.orders,
        profit: money(acc.profit + day.profit),
        ref: money(acc.ref + day.ref),
      }),
      { orders: 0, profit: 0, ref: 0 },
    );
    assert.deepEqual(summed, { orders: 1, profit: 27, ref: 5.94 });
    assert.ok(recent_orders.length === 1 && recent_orders[0].status === 'completed');
    assert.ok(recent_accruals.length === 3);
  });

  await step('seed-demo builds a 3-level downline and refuses to repeat', async () => {
    const seeded = await post('/api/admin/seed-demo', {}, rootToken);
    assert.equal(seeded.status, 200);
    assert.equal(seeded.json.ok, true);
    assert.deepEqual(seeded.json.created, { users: 3, orders: 3, accruals: 6 });
    const again = await post('/api/admin/seed-demo', {}, rootToken);
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'demo_exists');
    const overview = await get('/api/admin/overview', rootToken);
    assert.equal(overview.json.totals.orders_completed, 4);
  });

  await step('the timer (tick) completes due orders automatically', async () => {
    const e = await login(1005, 'Eve');
    const created = await post('/api/orders', { plan_id: 'start', amount: 100, rate: 0.27 }, e.token);
    assert.equal(created.status, 200);
    const id = created.json.order.id;
    assert.equal(created.json.order.status, 'active');
    // pretend the plan period has already elapsed
    db.run('UPDATE orders SET completes_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), id);
    const before = await get('/api/orders', e.token);
    assert.ok(
      ['active', 'completed'].includes(before.json.orders[0].status),
      'the order must still be completable (the 20s timer may have fired already)',
    );
    // /api/me runs the same completion routine the 20s interval calls
    const me = await get('/api/me', e.token);
    assert.equal(me.status, 200);
    const after = await get('/api/orders', e.token);
    const order = after.json.orders[0];
    assert.equal(order.status, 'completed', 'the tick must complete a due order');
    assert.equal(money(order.profit), 27);
    assert.equal(money(me.json.user.balance), 127);
    assert.equal(money(me.json.user.total_profit), 27);
    // a second tick must not credit anything twice
    await get('/api/me', e.token);
    const stable = await get('/api/me', e.token);
    assert.equal(money(stable.json.user.balance), 127);
    const accruals = await get('/api/admin/accruals?limit=500', rootToken);
    assert.equal(accruals.json.accruals.filter((row) => row.order_id === id).length, 0, 'no upline → no accruals');
  });

  await step('session tokens expire and are refreshed on use', async () => {
    const row = () => db.get('SELECT expires_at FROM sessions WHERE token = ?', rootToken);
    const first = row();
    assert.ok(first && Number.isFinite(Date.parse(first.expires_at)), 'session row must exist');
    assert.ok(Date.parse(first.expires_at) > Date.now(), 'session must not be expired');
    await get('/api/me', rootToken);
    const second = row();
    assert.ok(Date.parse(second.expires_at) >= Date.parse(first.expires_at), 'expiry must be refreshed on use');
    db.run("UPDATE sessions SET expires_at = ? WHERE token = ?", new Date(Date.now() - 1000).toISOString(), rootToken);
    const stale = await get('/api/me', rootToken);
    assert.equal(stale.status, 401);
    assert.equal(db.get('SELECT COUNT(*) AS c FROM sessions WHERE token = ?', rootToken).c, 0, 'expired session must be dropped');
    rootToken = (await post('/api/auth', { devTgId: '111' })).json.token;
  });

  await step('unknown /api/* path returns JSON 404', async () => {
    const response = await get('/api/definitely/not/handled');
    assert.equal(response.status, 404);
    assert.equal(response.json.error, 'not_found');
    const postResponse = await post('/api/definitely/not/handled', {});
    assert.equal(postResponse.status, 404);
  });

  await step('static: / serves index.html, /assets/* is served, /admin is routed', async () => {
    const index = await api('GET', '/', { raw: true });
    assert.equal(index.status, 200);
    assert.ok(index.text.includes('<'), 'index.html must be HTML');

    const manifest = await get('/assets/tonconnect-manifest.json');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.json.name, 'ARVEX Dashboard');

    const admin = await api('GET', '/admin', { raw: true });
    const adminExists = fs.existsSync(path.join(__dirname, '..', 'public', 'admin.html'));
    if (adminExists) {
      assert.equal(admin.status, 200, 'GET /admin must serve public/admin.html');
    } else {
      assert.equal(admin.status, 404);
      assert.equal(admin.json.error, 'admin.html_missing');
    }
  });

  console.log(`\n  root admin id     : ${ROOT_ID} (is_root in db: ${db.isRoot(ROOT_ID)})`);
  console.log(`  referral tree     : A(${USER_A}) → B(${USER_B}) → C(${USER_C}) → D(${USER_D})`);
  console.log(`  completed order   : #${demoOrderId} $100 @ 27% → profit $27, owner balance $127`);
  console.log(`  accruals          : L1 $2.70 (C) / L2 $1.89 (B) / L3 $1.35 (A)`);

  await server.close();
  return results.filter((result) => !result.ok).length;
}

/* -------------------------------------------------------------------------- */
/* reporting                                                                   */
/* -------------------------------------------------------------------------- */

function cleanup() {
  try {
    db.db.close();
  } catch {
    /* already closed */
  }
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main()
  .then((failed) => {
    const passed = results.filter((result) => result.ok).length;
    console.log('\n──────────────────────────────────────────────────────────────');
    console.log(`  smoke summary : ${passed} passed, ${failed} failed (${results.length} total)`);
    if (failed > 0) {
      console.log('\n  failures:');
      for (const result of results) {
        if (!result.ok) console.log(`    - ${result.name}: ${result.error && result.error.message}`);
      }
    }
    console.log('──────────────────────────────────────────────────────────────');
    console.log(failed === 0 ? '  PASS\n' : '  FAIL\n');
    cleanup();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('\n[arvex-smoke] fatal error:', (error && error.stack) || error);
    cleanup();
    process.exit(1);
  });
