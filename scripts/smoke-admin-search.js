const Database = require('better-sqlite3');
const { hashSync } = require('bcryptjs');

const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const username = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
const password = process.env.ADMIN_SMOKE_PASSWORD || 'origin-admin-dev-2026!';
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

function withDb(callback) {
  const db = new Database(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function createFixtures() {
  return withDb((db) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const user = db.prepare(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (?, ?, ?, ?, 1)
       RETURNING id, username`,
    ).get(`search_smoke_${suffix}`, `search_smoke_${suffix}@example.test`, 'Search Smoke User', hashSync(crypto.randomUUID(), 10));
    const projectId = `proj_search_smoke_${suffix}`;
    const orderId = `order_search_smoke_${suffix}`;
    const batchId = `batch_search_smoke_${suffix}`;
    const videoTaskId = `video_search_smoke_${suffix}`;
    const exportId = `export_search_smoke_${suffix}`;

    db.prepare(
      `INSERT INTO projects (id, owner_id, title, description, status)
       VALUES (?, ?, ?, '', 'draft')`,
    ).run(projectId, user.id, 'Search Smoke Project');
    db.prepare(
      `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, provider_ref, amount_cents, currency, credits_added, status)
       VALUES (?, ?, 'topup', 'smoke_pack', 'manual', ?, 9900, 'CNY', 1000, 'paid')`,
    ).run(orderId, user.id, `provider_ref_${suffix}`);
    db.prepare(
      `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total, succeeded, failed, error_message)
       VALUES (?, ?, ?, 'storyboard_images', 'failed', 3, 1, 2, 'smoke batch failure')`,
    ).run(batchId, user.id, projectId);
    db.prepare(
      `INSERT INTO video_tasks (id, owner_id, project_id, prompt, provider, provider_task, status, progress, filename, error_message)
       VALUES (?, ?, ?, 'smoke prompt', 'fake', ?, 'completed', 100, 'smoke.mp4', NULL)`,
    ).run(videoTaskId, user.id, projectId, `provider_video_${suffix}`);
    db.prepare(
      `INSERT INTO exports (id, owner_id, project_id, status, progress, provider, external_export_id, filename, edl_json, error_message)
       VALUES (?, ?, ?, 'completed', 100, 'local', ?, 'smoke-export.mp4', '{}', NULL)`,
    ).run(exportId, user.id, projectId, `external_export_${suffix}`);

    return { user, projectId, orderId, batchId, videoTaskId, exportId };
  });
}

function cleanupFixtures(fx) {
  withDb((db) => {
    db.prepare('DELETE FROM exports WHERE id = ?').run(fx.exportId);
    db.prepare('DELETE FROM video_tasks WHERE id = ?').run(fx.videoTaskId);
    db.prepare('DELETE FROM batch_tasks WHERE batch_id = ?').run(fx.batchId);
    db.prepare('DELETE FROM batches WHERE id = ?').run(fx.batchId);
    db.prepare('DELETE FROM billing_orders WHERE id = ?').run(fx.orderId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(fx.projectId);
    db.prepare('DELETE FROM user_credits WHERE user_id = ?').run(fx.user.id);
    db.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(fx.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(fx.user.id);
  });
}

async function assertSearch(cookie, q, expectedType, expectedId) {
  const result = await request(`/api/admin/search?q=${encodeURIComponent(q)}`, { headers: { cookie } });
  assert(result.res.status === 200, `search ${q} failed: ${result.res.status} ${result.text}`);
  assert(result.json && Array.isArray(result.json.items), `search ${q} did not return items`);
  const found = result.json.items.find((item) => item.entityType === expectedType && String(item.id) === String(expectedId));
  assert(found, `search ${q} did not find ${expectedType}:${expectedId}; got ${JSON.stringify(result.json.items)}`);
  assert(result.json.groups && Array.isArray(result.json.groups[expectedType]), `search ${q} did not group ${expectedType}`);
}

async function main() {
  const cookie = await login();
  const page = await request('/admin/search', { headers: { cookie } });
  assert(page.res.status === 200, `admin search page failed: ${page.res.status} ${page.text}`);
  assert(page.text.includes('data-admin-search-input="true"'), 'admin search page should render a search input');
  assert(page.text.includes('/api/admin/search'), 'admin search page should be wired to /api/admin/search');
  assert(!page.text.includes('P1-C 接入'), 'admin search page should not render the old placeholder panel');

  const empty = await request('/api/admin/search', { headers: { cookie } });
  assert(empty.res.status === 200, `empty search failed: ${empty.res.status} ${empty.text}`);
  assert(empty.json.items.length === 0, 'empty search should return no items');

  const fx = createFixtures();
  try {
    await assertSearch(cookie, String(fx.user.id), 'user', fx.user.id);
    await assertSearch(cookie, fx.user.username, 'user', fx.user.id);
    await assertSearch(cookie, fx.orderId, 'order', fx.orderId);
    await assertSearch(cookie, fx.projectId, 'project', fx.projectId);
    await assertSearch(cookie, fx.batchId, 'batch', fx.batchId);
    await assertSearch(cookie, fx.videoTaskId, 'video_task', fx.videoTaskId);
    await assertSearch(cookie, fx.exportId, 'export', fx.exportId);
  } finally {
    cleanupFixtures(fx);
  }

  console.log('admin search smoke ok: exact multi-entity lookup is wired');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
