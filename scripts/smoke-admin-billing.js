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
  const cookie = (result.res.headers.get('set-cookie') || '').split(';')[0];
  assert(cookie.includes('admin_token='), 'admin login did not set admin_token cookie');
  return cookie;
}

function withDb(callback) {
  const db = new Database(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function createFixture() {
  return withDb((db) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const user = db.prepare(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (?, ?, ?, ?, 1)
       RETURNING id, username`,
    ).get(`billing_smoke_${suffix}`, `billing_smoke_${suffix}@example.test`, 'Billing Smoke User', hashSync(crypto.randomUUID(), 10));
    db.prepare(
      `INSERT INTO user_credits (user_id, total_credits, bonus_credits)
       VALUES (?, 100, 100)`,
    ).run(user.id);
    const orderId = `order_billing_smoke_${suffix}`;
    db.prepare(
      `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, provider_ref, amount_cents, currency, credits_added, status)
       VALUES (?, ?, 'topup', 'topup_500', 'manual', ?, 1900, 'CNY', 500, 'paid')`,
    ).run(orderId, user.id, `provider_billing_${suffix}`);
    return { user, orderId };
  });
}

function cleanupFixture(fx) {
  withDb((db) => {
    db.prepare('DELETE FROM billing_orders WHERE id = ?').run(fx.orderId);
    db.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(fx.user.id);
    db.prepare('DELETE FROM user_credits WHERE user_id = ?').run(fx.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(fx.user.id);
  });
}

async function mutate(cookie, body, reason) {
  const key = crypto.randomUUID();
  return request('/api/admin/billing', {
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

function readCredits(userId) {
  return withDb((db) => db.prepare('SELECT * FROM user_credits WHERE user_id = ?').get(userId));
}

async function main() {
  const cookie = await login();
  const page = await request('/admin/billing', { headers: { cookie } });
  assert(page.res.status === 200, `billing page failed: ${page.res.status} ${page.text}`);
  assert(page.text.includes('/api/admin/billing'), 'billing page should be wired to /api/admin/billing');

  const fx = createFixture();
  try {
    const list = await request(`/api/admin/billing?q=${encodeURIComponent(fx.user.username)}`, { headers: { cookie } });
    assert(list.res.status === 200, `billing list failed: ${list.res.status} ${list.text}`);
    assert(list.json.users.some((u) => u.id === fx.user.id), 'billing users did not include fixture user');
    assert(list.json.orders.some((o) => o.id === fx.orderId), 'billing orders did not include fixture order');
    assert(list.json.cost && Array.isArray(list.json.cost.revenue), 'billing cost snapshot missing revenue array');

    const dry = await mutate(cookie, { action: 'manual_adjust', userId: fx.user.id, amount: 25, dryRun: true }, 'billing smoke dry adjust');
    assert(dry.res.status === 200, `dry adjust failed: ${dry.res.status} ${dry.text}`);
    assert(dry.json && dry.json.dryRun === true, 'dry adjust did not return dryRun payload');
    assert(readCredits(fx.user.id).total_credits === 100, 'dry adjust mutated credits');

    const commit = await mutate(cookie, { action: 'manual_adjust', userId: fx.user.id, amount: 25 }, 'billing smoke adjust');
    assert(commit.res.status === 200, `adjust failed: ${commit.res.status} ${commit.text}`);
    assert(readCredits(fx.user.id).total_credits === 125, 'manual adjust did not update credits');
    const ledger = withDb((db) => db.prepare(
      `SELECT amount, admin_user_id FROM credit_ledger WHERE user_id = ? AND kind = 'adjust' ORDER BY created_at DESC LIMIT 1`,
    ).get(fx.user.id));
    assert(ledger && Number(ledger.amount) === 25 && ledger.admin_user_id, 'manual adjust ledger missing admin_user_id');

    const block = await mutate(cookie, { action: 'manual_adjust', userId: fx.user.id, amount: 10001 }, 'billing smoke large adjust missing confirm');
    assert(block.res.status === 400, `large adjust without CONFIRM should be 400, got ${block.res.status}`);
  } finally {
    cleanupFixture(fx);
  }

  console.log('admin billing smoke ok: orders/ledger/cost and manual adjust are wired');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
