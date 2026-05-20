const Database = require('better-sqlite3');
const { hashSync } = require('bcryptjs');
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const username = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
const password = process.env.ADMIN_SMOKE_PASSWORD || 'origin-admin-dev-2026!';
const origin = process.env.ADMIN_SMOKE_ORIGIN || 'http://localhost:3000';
const dbPath = process.env.ADMIN_SMOKE_DB_PATH || 'data/qd.sqlite';
const dataDir = process.env.ORIGIN_DATA_DIR || process.env.DATA_DIR || 'data';

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
    const password = `content-smoke-${suffix}!Aa1`;
    const user = db.prepare(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (?, ?, ?, ?, 1)
       RETURNING id, username`,
    ).get(`content_smoke_${suffix}`, `content_smoke_${suffix}@example.test`, 'Content Smoke User', hashSync(password, 10));
    const projectId = `proj_content_smoke_${suffix}`;
    db.prepare(
      `INSERT INTO projects (id, owner_id, title, description, status)
       VALUES (?, ?, 'Content Smoke Project', '', 'draft')`,
    ).run(projectId, user.id);
    const imageId = `img-content-smoke-${suffix.replace(/_/g, '-')}`;
    const imageFilename = `${imageId}.png`;
    const imageDir = join(dataDir, 'images', String(user.id));
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, imageFilename), Buffer.from('smoke-image-bytes'));
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, prompt, style)
       VALUES (?, ?, ?, 'other', '', ?, 'image/png', 17, 'content smoke image', '')`,
    ).run(imageId, user.id, projectId, imageFilename);
    const flagId = `flag_content_smoke_${suffix}`;
    db.prepare(
      `INSERT INTO content_flags (id, owner_id, project_id, source_type, source_id, raw_excerpt, scan_reason, severity, status)
       VALUES (?, ?, ?, 'image', ?, 'smoke risky excerpt', 'smoke_keyword', 'high', 'pending')`,
    ).run(flagId, user.id, projectId, imageId);
    return { user, password, projectId, flagId, imageId, imagePath: join(imageDir, imageFilename) };
  });
}

function cleanupFixture(fx) {
  withDb((db) => {
    db.prepare('DELETE FROM admin_actions WHERE target_id = ?').run(fx.flagId);
    db.prepare('DELETE FROM content_flags WHERE id = ?').run(fx.flagId);
    db.prepare('DELETE FROM images WHERE id = ?').run(fx.imageId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(fx.projectId);
    db.prepare('DELETE FROM users WHERE id = ?').run(fx.user.id);
  });
  try { rmSync(fx.imagePath, { force: true }); } catch {}
  if (fx.quarantineId) {
    try { rmSync(join(dataDir, 'quarantine', fx.quarantineId), { recursive: true, force: true }); } catch {}
  }
}

async function mutate(cookie, body, reason) {
  return request('/api/admin/content', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'x-idempotency-key': crypto.randomUUID(),
      'x-admin-reason': reason,
    },
    body: JSON.stringify({ ...body, reason }),
  });
}

async function main() {
  const cookie = await login();
  const page = await request('/admin/content', { headers: { cookie } });
  assert(page.res.status === 200, `content page failed: ${page.res.status} ${page.text}`);
  assert(page.text.includes('/api/admin/content'), 'content page should be wired to /api/admin/content');
  assert(!page.text.includes('P1-F 接入'), 'content page should not render old placeholder');

  const fx = createFixture();
  try {
    const userToken = await loginUser(fx.user.username, fx.password);
    const beforeFile = await request(`/api/images/file/${encodeURIComponent(fx.imageId)}`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert(beforeFile.res.status === 200, `image file should be readable before hide: ${beforeFile.res.status} ${beforeFile.text}`);

    const list = await request(`/api/admin/content?q=${encodeURIComponent(fx.flagId)}`, { headers: { cookie } });
    assert(list.res.status === 200, `content list failed: ${list.res.status} ${list.text}`);
    assert(list.json.items.some((item) => item.id === fx.flagId), 'content list did not include fixture flag');

    const dry = await mutate(cookie, { id: fx.flagId, action: 'hide', dryRun: true }, 'content smoke dry hide');
    assert(dry.res.status === 200, `dry hide failed: ${dry.res.status} ${dry.text}`);
    assert(dry.json && dry.json.dryRun === true, 'dry hide did not return dryRun payload');
    const before = withDb((db) => db.prepare('SELECT status FROM content_flags WHERE id = ?').get(fx.flagId));
    assert(before.status === 'pending', 'dry hide mutated flag');
    assert(existsSync(fx.imagePath), 'dry hide moved image file');

    const hide = await mutate(cookie, { id: fx.flagId, action: 'hide' }, 'content smoke hide');
    assert(hide.res.status === 200, `hide failed: ${hide.res.status} ${hide.text}`);
    fx.quarantineId = hide.json?.disposition?.quarantineId || null;
    const after = withDb((db) => db.prepare('SELECT status, reviewed_by, reviewed_at FROM content_flags WHERE id = ?').get(fx.flagId));
    assert(after.status === 'hidden' && after.reviewed_by && after.reviewed_at, 'hide did not review flag');
    assert(!existsSync(fx.imagePath), 'hide did not quarantine original image file');
    const afterFile = await request(`/api/images/file/${encodeURIComponent(fx.imageId)}`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert(afterFile.res.status === 404, `hidden image file should return 404: ${afterFile.res.status} ${afterFile.text}`);
  } finally {
    cleanupFixture(fx);
  }

  console.log('admin content smoke ok: content_flags hide physically quarantines media and file endpoint returns 404');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
