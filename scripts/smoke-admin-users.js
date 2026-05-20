const Database = require('better-sqlite3');
const { hashSync } = require('bcryptjs');

const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const username = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
const password = process.env.ADMIN_SMOKE_PASSWORD || 'origin-admin-dev-2026!';
const origin = process.env.ADMIN_SMOKE_ORIGIN || 'http://localhost:3000';
const dbPath = process.env.ADMIN_SMOKE_DB_PATH || 'data/qd.sqlite';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const res = await fetch(baseUrl + path, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

async function login() {
  const result = await request('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert(result.res.status === 200, `admin login failed: ${result.res.status} ${result.text}`);
  const setCookie = result.res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  assert(cookie.includes('admin_token='), 'admin login did not set admin_token cookie');
  return cookie;
}

async function mutateUser(cookie, body, reason) {
  const key = crypto.randomUUID();
  return request('/api/admin/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'x-idempotency-key': key,
      'x-admin-reason': reason,
    },
    body: JSON.stringify({ ...body, reason }),
  });
}

function withDb(callback) {
  const db = new Database(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function createTempUser(prefix = 'admin_smoke_user') {
  return withDb((db) => {
    const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const row = db.prepare(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (?, NULL, ?, ?, 1)
       RETURNING id, username`,
    ).get(name, 'Admin Smoke User', hashSync(crypto.randomUUID(), 10));
    return row;
  });
}

function readUser(id) {
  return withDb((db) => db.prepare('SELECT id, username, disabled_at, token_revoked_at FROM users WHERE id = ?').get(id));
}

function deleteUser(id) {
  withDb((db) => {
    db.prepare('DELETE FROM user_credits WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
}

async function main() {
  const cookie = await login();
  const list = await request('/api/admin/users', { headers: { cookie } });
  assert(list.res.status === 200, `list users failed: ${list.res.status} ${list.text}`);
  assert(list.json && Array.isArray(list.json.items), 'list users did not return items array');

  const temp = createTempUser();
  const shadow = createTempUser('__shadow__admin_smoke');
  try {
    const search = await request(`/api/admin/users?q=${encodeURIComponent(temp.username)}`, { headers: { cookie } });
    assert(search.res.status === 200, `search temp user failed: ${search.res.status} ${search.text}`);
    assert(search.json.items.some((u) => u.id === temp.id), 'search did not find temp user');
    assert(!search.json.items.some((u) => String(u.username).startsWith('__shadow__')), 'user list leaked shadow users');

    const dryRun = await mutateUser(cookie, { action: 'disable', userId: temp.id, dryRun: true }, 'admin users smoke dry-run disable');
    assert(dryRun.res.status === 200, `dry-run disable failed: ${dryRun.res.status} ${dryRun.text}`);
    assert(dryRun.json && dryRun.json.dryRun === true, 'dry-run disable did not return dryRun payload');
    assert(!readUser(temp.id).disabled_at, 'dry-run disable mutated the user');

    const disable = await mutateUser(cookie, { action: 'disable', userId: temp.id }, 'admin users smoke disable');
    assert(disable.res.status === 200, `disable failed: ${disable.res.status} ${disable.text}`);
    const disabled = readUser(temp.id);
    assert(disabled.disabled_at, 'disable did not set disabled_at');
    assert(disabled.token_revoked_at, 'disable did not set token_revoked_at');

    const restore = await mutateUser(cookie, { action: 'restore', userId: temp.id }, 'admin users smoke restore');
    assert(restore.res.status === 200, `restore failed: ${restore.res.status} ${restore.text}`);
    const restored = readUser(temp.id);
    assert(!restored.disabled_at, 'restore did not clear disabled_at');
    assert(restored.token_revoked_at === disabled.token_revoked_at, 'restore should not clear or rotate token_revoked_at');

    const forceLogout = await mutateUser(cookie, { action: 'force_logout', userId: temp.id }, 'admin users smoke force logout');
    assert(forceLogout.res.status === 200, `force logout failed: ${forceLogout.res.status} ${forceLogout.text}`);
    const loggedOut = readUser(temp.id);
    assert(loggedOut.token_revoked_at, 'force logout did not set token_revoked_at');

    const shadowDisable = await mutateUser(cookie, { action: 'disable', userId: shadow.id }, 'admin users smoke shadow block');
    assert(shadowDisable.res.status === 400, `shadow disable should be blocked with 400, got ${shadowDisable.res.status}`);
  } finally {
    deleteUser(temp.id);
    deleteUser(shadow.id);
  }

  console.log('admin users smoke ok: list/search/disable/restore/force_logout are wired');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
