const Database = require('better-sqlite3');

const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const origin = process.env.ADMIN_SMOKE_ORIGIN || 'http://localhost:3000';
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
    const id = `token_stats_smoke_${suffix}`;
    db.prepare(
      `INSERT INTO token_usage_events
        (id, owner_id, username_snapshot, project_id, project_title_snapshot, request_path,
         route_name, trace_name, module_key, module_label, feature_key, feature_label,
         call_item_type, call_item_id, call_item_label, provider, model, model_role, slot,
         status, latency_ms, input_tokens, output_tokens, reasoning_tokens, total_tokens,
         billable_tokens, usage_source, meta_json)
       VALUES
        (?, NULL, 'smoke-user', ?, 'Smoke Project', '/smoke/token', 'smoke.token',
         'smoke-token-stats', 'smoke', 'Smoke', 'smoke_call', 'Smoke Call',
         'test', ?, 'Smoke Call Item', 'openai_chat', 'smoke-model', 'brain', 'brain',
         'ok', 12, 11, 22, 3, 36, 36, 'provider', '{}')`,
    ).run(id, id, id);
    return { id };
  });
}

function cleanupFixture(fx) {
  withDb((db) => {
    db.prepare('DELETE FROM token_usage_events WHERE id = ? OR project_id = ?').run(fx.id, fx.id);
    db.prepare("DELETE FROM admin_actions WHERE action = 'token_stats.export' AND result_json LIKE '%200%'").run();
  });
}

async function main() {
  const fx = createFixture();
  try {
    const cookie = await login();
    const page = await request('/admin/token-stats', { headers: { cookie } });
    assert(page.res.status === 200, `token stats page failed: ${page.res.status} ${page.text}`);
    assert(page.text.includes('data-token-range="true"'), 'token stats page should render range filter');
    assert(page.text.includes('/api/admin/token-stats'), 'token stats page should be wired to token stats API');
    assert(page.text.includes('Token 统计不是现金成本统计'), 'token stats page should explain token is not cash cost');

    const base = `/api/admin/token-stats?range=30d&q=${encodeURIComponent(fx.id)}`;
    for (const view of ['summary', 'users', 'categories', 'calls']) {
      const result = await request(`${base}&view=${view}`, { headers: { cookie } });
      assert(result.res.status === 200, `${view} failed: ${result.res.status} ${result.text}`);
      assert(result.json && result.json.ok === true, `${view} did not return ok json`);
    }
    const calls = await request(`${base}&view=calls`, { headers: { cookie } });
    assert(calls.json.rows.some((row) => row.id === fx.id), 'calls view did not include fixture event');

    const csv = await request('/api/admin/token-stats', {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-admin-reason': 'token stats smoke export',
      },
      body: JSON.stringify({ action: 'export', range: '30d', q: fx.id, limit: 100 }),
    });
    assert(csv.res.status === 200, `csv export failed: ${csv.res.status} ${csv.text}`);
    assert((csv.res.headers.get('content-type') || '').includes('text/csv'), 'csv export should return text/csv');
    assert(csv.text.includes('created_at,owner_id,username'), 'csv export missing header');
    assert(csv.text.includes(fx.id), 'csv export missing fixture row');
    assert(!csv.text.includes('prompt content') && !csv.text.includes('response content'), 'csv export should not contain raw prompt/response');

    console.log('admin token stats smoke ok: page, summary/users/categories/calls API, and audited CSV export passed');
  } finally {
    cleanupFixture(fx);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
