'use strict';

/**
 * ARVEX auth — Telegram Mini App `initData` verification + session tokens.
 *
 * Secure mode (BOT_TOKEN set): official algorithm —
 *   1. parse the urlencoded initData parameters,
 *   2. drop `hash`,
 *   3. sort the remaining `key=value` pairs by key and join with "\n"
 *      → data_check_string,
 *   4. secret = HMAC_SHA256(key = "Bot#" + BOT_TOKEN, data = data_check_string) hex,
 *      compared to `hash` in constant time,
 *   5. reject when `auth_date` is missing or older than 86400 seconds.
 *
 * The officially derived secret (HMAC("WebAppData", BOT_TOKEN) as key) is
 * accepted as an alternative so real Telegram clients also pass.
 *
 * Insecure mode (no BOT_TOKEN): initData is parsed without verification and
 * `POST /api/auth` additionally accepts `{ devTgId, devName? }`.
 *
 * Session tokens are 32 random bytes hex, stored in `sessions`, checked with
 * expiry and refreshed on every use.
 */

const crypto = require('node:crypto');

const config = require('./config');
const db = require('./db');

/** initData / auth_date older than this is rejected. */
const MAX_AUTH_AGE_SECONDS = 86400;

/** Small helper: an Error carrying an HTTP status for the routes' error handler. */
function httpError(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  if (extra) Object.assign(error, extra);
  return error;
}

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(String(data), 'utf8').digest('hex');
}

/** All accepted hashes for a data_check_string (official formula first). */
function candidateHashes(dataCheckString) {
  /* Official Mini App formula (core.telegram.org/bots/webapps):
       secret_key      = HMAC_SHA256(key = "WebAppData", data = BOT_TOKEN)
       computed_hash   = HMAC_SHA256(key = secret_key,  data = data_check_string)
     The older `Bot#<token>` derivation is kept as a fallback. */
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(String(config.BOT_TOKEN), 'utf8').digest();
  const list = [crypto.createHmac('sha256', secretKey).update(dataCheckString, 'utf8').digest('hex')];
  list.push(hmacHex(`Bot#${config.BOT_TOKEN}`, dataCheckString));
  return list;
}

/** Constant-time comparison of two hex digests. */
function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Normalise `initDataUnsafe.user` (object or JSON string) → { tg_id, first_name, username }. */
function normalizeTelegramUser(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const tgId = Number(value.id ?? value.tg_id);
  if (!Number.isSafeInteger(tgId) || tgId <= 0) return null;
  const firstName = typeof value.first_name === 'string' ? value.first_name.trim().slice(0, 64) : null;
  const username = typeof value.username === 'string' && value.username ? value.username.trim().slice(0, 64) : null;
  return { tg_id: tgId, first_name: firstName, username };
}

/**
 * Parse initData into `{ params, user, startParam, dataCheckString, hash }`.
 * Accepts the urlencoded form and an `initDataUnsafe`-style JSON string.
 */
function parseInitData(initData) {
  if (typeof initData !== 'string' || !initData.trim()) {
    return { error: 'missing_initData' };
  }
  const text = initData.trim();

  // `{"initDataUnsafe":{...}}` style payload (dev / tests)
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: 'invalid_initData' };
    }
    const unsafe = parsed && typeof parsed.initDataUnsafe === 'object' ? parsed.initDataUnsafe : parsed;
    return {
      params: parsed && typeof parsed === 'object' ? parsed : {},
      user: normalizeTelegramUser(unsafe && unsafe.user),
      startParam: String((unsafe && unsafe.startparam) || (parsed && parsed.startparam) || ''),
      hash: parsed && parsed.hash ? String(parsed.hash) : '',
      dataCheckString: '',
    };
  }

  // urlencoded query string (optionally prefixed with "?")
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  let search;
  try {
    search = new URLSearchParams(query);
  } catch {
    return { error: 'invalid_initData' };
  }
  const pairs = [];
  const params = {};
  for (const [key, value] of search.entries()) {
    params[key] = value;
    if (key !== 'hash') pairs.push({ key, value });
  }
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const dataCheckString = pairs.map((pair) => `${pair.key}=${pair.value}`).join('\n');

  return {
    params,
    user: normalizeTelegramUser(params.user),
    startParam: typeof params.startparam === 'string' ? params.startparam : '',
    hash: typeof params.hash === 'string' ? params.hash : '',
    authDate: params.auth_date,
    dataCheckString,
  };
}

/**
 * Verify initData. Returns `{ ok:true, user, startParam }` or `{ ok:false, error }`.
 * In insecure mode the signature and auth_date checks are skipped.
 */
function verifyInitData(initData) {
  const parsed = parseInitData(initData);
  if (parsed.error) return { ok: false, error: parsed.error };
  if (!parsed.user) return { ok: false, error: 'invalid_initData_user' };

  if (config.INSECURE) {
    return { ok: true, user: parsed.user, startParam: parsed.startParam, verified: false };
  }

  if (!parsed.hash) return { ok: false, error: 'missing_hash' };
  const expected = candidateHashes(parsed.dataCheckString);
  let matched = false;
  for (const digest of expected) {
    // evaluate every candidate so the result does not leak which one matched
    const hit = safeEqualHex(digest, parsed.hash);
    matched = matched || hit;
  }
  if (!matched) return { ok: false, error: 'invalid_hash' };

  const authDate = Number(parsed.authDate);
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: 'missing_auth_date' };
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > MAX_AUTH_AGE_SECONDS) return { ok: false, error: 'stale_auth_date' };

  return { ok: true, user: parsed.user, startParam: parsed.startParam, verified: true };
}

/* -------------------------------------------------------------------------- */
/* referral tree helpers (invite link → referrer)                              */
/* -------------------------------------------------------------------------- */

/** Would parenting `selfTgId` to `parentId` create a loop? (50 hop cap) */
function wouldCreateCycle(selfTgId, parentId) {
  let node = db.getUser(parentId);
  let hops = 0;
  while (node && node.referrer_id !== null && node.referrer_id !== undefined && hops < 50) {
    if (Number(node.referrer_id) === Number(selfTgId)) return true;
    node = db.getUser(node.referrer_id);
    hops += 1;
  }
  return false;
}

/**
 * Resolve a `startparam` (`ref_<code>` or plain `<code>`) into a referrer row.
 * Only when the referrer exists, is not the user themself and creates no cycle.
 */
function resolveReferrer(startParam, selfTgId) {
  if (!startParam) return null;
  let code = String(startParam).trim().toLowerCase();
  if (!code) return null;
  if (code.startsWith('ref_')) code = code.slice(4);
  if (!/^[a-z0-9]{6,10}$/.test(code)) return null;
  const referrer = db.getUserByCode(code);
  if (!referrer) return null;
  if (Number(referrer.tg_id) === Number(selfTgId)) return null;
  if (wouldCreateCycle(selfTgId, referrer.tg_id)) return null;
  return referrer;
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                    */
/* -------------------------------------------------------------------------- */

function createSession(tgId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  db.run(
    'INSERT INTO sessions (token, tg_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    token,
    Number(tgId),
    db.nowIso(now),
    db.isoIn(config.SESSION_TTL_MS, now),
  );
  return token;
}

function bearerToken(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof header === 'string' && header.trim()) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
    return header.trim();
  }
  return null;
}

/**
 * Resolve the caller from `Authorization: Bearer <token>`.
 * Expired sessions are deleted; valid ones are refreshed (sliding TTL).
 * Returns `{ token, user }` or null.
 */
function sessionUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const session = db.get('SELECT * FROM sessions WHERE token = ?', token);
  if (!session) return null;
  const expiresAt = Date.parse(session.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    db.run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  const user = db.getUser(session.tg_id);
  if (!user) {
    db.run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  // refresh on use
  db.run(
    'UPDATE sessions SET expires_at = ? WHERE token = ?',
    db.isoIn(config.SESSION_TTL_MS),
    token,
  );
  return { token, user };
}

/** A user is an admin when a row exists in `admins` (ROOT_ADMIN_ID is always one). */
function verifyAdmin(tgId) {
  return db.isAdmin(tgId);
}

/* -------------------------------------------------------------------------- */
/* serialisation + login                                                       */
/* -------------------------------------------------------------------------- */

/** Public `user` shape from API.md. */
function serializeUser(user) {
  if (!user) return null;
  const referrer = user.referrer_id ? db.getUser(user.referrer_id) : null;
  return {
    tg_id: Number(user.tg_id),
    code: user.code,
    first_name: user.first_name === null || user.first_name === undefined ? null : user.first_name,
    username: user.username === null || user.username === undefined ? null : user.username,
    balance: db.round2(user.balance),
    ref_balance: db.round2(user.ref_balance),
    total_profit: db.round2(user.total_profit),
    total_ref: db.round2(user.total_ref),
    is_admin: db.isAdmin(user.tg_id),
    is_root: db.isRoot(user.tg_id),
    banned: Number(user.banned) === 1,
    referrer: referrer
      ? {
          tg_id: Number(referrer.tg_id),
          code: referrer.code,
          first_name: referrer.first_name === null || referrer.first_name === undefined ? null : referrer.first_name,
        }
      : null,
  };
}

/**
 * POST /api/auth.
 * Body: `{ initData?, devTgId?, devName?, startparam? }` → `{ token, user }`.
 */
function login(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  let identity = null;

  if (typeof payload.initData === 'string' && payload.initData.trim()) {
    const verified = verifyInitData(payload.initData);
    if (!verified.ok) throw httpError(401, verified.error);
    identity = {
      tg_id: verified.user.tg_id,
      first_name: verified.user.first_name,
      username: verified.user.username,
      startParam: verified.startParam,
    };
  } else if (config.INSECURE && payload.devTgId !== undefined && payload.devTgId !== null && String(payload.devTgId).trim() !== '') {
    const tgId = Number(payload.devTgId);
    if (!Number.isSafeInteger(tgId) || tgId <= 0) throw httpError(400, 'invalid_devTgId');
    const devName = typeof payload.devName === 'string' ? payload.devName.trim().slice(0, 64) : '';
    identity = {
      tg_id: tgId,
      first_name: devName || 'Dev User',
      username: null,
      startParam: typeof payload.startparam === 'string' ? payload.startparam : '',
    };
  } else {
    throw httpError(401, 'missing_initData');
  }

  if (!Number.isSafeInteger(identity.tg_id) || identity.tg_id <= 0) {
    throw httpError(401, 'invalid_initData_user');
  }

  const existing = db.getUser(identity.tg_id);
  const user = db.ensureUser({
    tg_id: identity.tg_id,
    first_name: identity.first_name,
    username: identity.username,
  });

  // The tree is linked on the first auth that carries a valid invite code and
  // is never rewritten afterwards (only an admin may re-parent).
  if (user && user.referrer_id === null && identity.startParam) {
    const referrer = resolveReferrer(identity.startParam, identity.tg_id);
    if (referrer && Number(referrer.tg_id) !== Number(user.tg_id)) db.setReferrer(user.tg_id, referrer.tg_id);
  }

  // ROOT_ADMIN_ID can never be banned.
  if (config.ROOT_ADMIN_TG_ID !== null && Number(identity.tg_id) === config.ROOT_ADMIN_TG_ID) {
    const fresh = db.getUser(identity.tg_id);
    if (fresh && Number(fresh.banned) === 1) db.setBanned(identity.tg_id, false);
  }

  const fresh = db.getUser(identity.tg_id);
  void existing;
  return { token: createSession(identity.tg_id), user: serializeUser(fresh) };
}

module.exports = {
  MAX_AUTH_AGE_SECONDS,
  httpError,
  parseInitData,
  verifyInitData,
  candidateHashes,
  safeEqualHex,
  resolveReferrer,
  wouldCreateCycle,
  createSession,
  sessionUser,
  bearerToken,
  verifyAdmin,
  serializeUser,
  login,
};
