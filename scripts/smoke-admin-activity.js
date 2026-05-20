const Database = require('better-sqlite3');
const { hashSync } = require('bcryptjs');

const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const adminUsername = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
const adminPassword = process.env.ADMIN_SMOKE_PASSWORD || 'origin-admin-dev-2026!';
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

function withDb(callback) {
  const db = new Database(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

async function loginAdmin() {
  const result = await request('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert(result.res.status === 200, `admin login failed: ${result.res.status} ${result.text}`);
  const cookie = (result.res.headers.get('set-cookie') || '').split(';')[0];
  assert(cookie.includes('admin_token='), 'admin login did not set admin_token cookie');
  return cookie;
}

async function loginUser(username, password) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert(result.res.status === 200, `user login failed: ${result.res.status} ${result.text}`);
  assert(result.json && result.json.token, 'user login did not return token');
  return result.json.token;
}

function createUserFixture() {
  return withDb((db) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const username = `activity_smoke_${suffix}`;
    const password = `activity-smoke-${suffix}!Aa1`;
    const user = db.prepare(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (?, ?, 'Activity Smoke User', ?, 1)
       RETURNING id, username`,
    ).get(username, `${username}@example.test`, hashSync(password, 10));
    return { user, username, password };
  });
}

function cleanupFixture(fx) {
  withDb((db) => {
    db.prepare('DELETE FROM user_activity WHERE user_id = ?').run(fx.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(fx.user.id);
  });
}

async function main() {
  const adminCookie = await loginAdmin();
  const fx = createUserFixture();
  try {
    const token = await loginUser(fx.username, fx.password);
    const activity = await request('/api/activity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: '/workspace#smoke' }),
    });
    assert(activity.res.status === 200, `activity heartbeat failed: ${activity.res.status} ${activity.text}`);
    const row = withDb((db) => db.prepare('SELECT * FROM user_activity WHERE user_id = ?').get(fx.user.id));
    assert(row && row.path === '/workspace#smoke', 'user_activity row was not written');

    const stats = await request('/api/admin/stats', { headers: { cookie: adminCookie } });
    assert(stats.res.status === 200, `admin stats failed: ${stats.res.status} ${stats.text}`);
    assert(stats.json.onlineUsers.some((item) => item.userId === fx.user.id), 'admin stats did not count heartbeat user online');
  } finally {
    cleanupFixture(fx);
  }
  console.log('admin activity smoke ok: user heartbeat writes user_activity and admin stats read it');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

