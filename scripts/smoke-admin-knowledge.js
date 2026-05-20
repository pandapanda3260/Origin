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

function createProject() {
  return withDb((db) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const user = db.prepare(
      `INSERT INTO users (username, email, display_name, password_hash, email_verified)
       VALUES (?, ?, ?, ?, 1)
       RETURNING id, username`,
    ).get(`knowledge_smoke_${suffix}`, `knowledge_smoke_${suffix}@example.test`, 'Knowledge Smoke User', hashSync(crypto.randomUUID(), 10));
    const projectId = `proj_knowledge_smoke_${suffix}`;
    db.prepare(
      `INSERT INTO projects (id, owner_id, title, description, status, data_json)
       VALUES (?, ?, 'Knowledge Smoke Project', '', 'draft', '{}')`,
    ).run(projectId, user.id);
    return { user, projectId };
  });
}

function cleanup(ids) {
  withDb((db) => {
    for (const id of ids.cards || []) db.prepare('DELETE FROM knowledge_cards WHERE id = ?').run(id);
    db.prepare('DELETE FROM admin_actions WHERE target_id IN (' + (ids.cards || ['']).map(() => '?').join(',') + ')').run(...(ids.cards || ['']));
    if (ids.projectId) db.prepare('DELETE FROM projects WHERE id = ?').run(ids.projectId);
    if (ids.userId) {
      db.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(ids.userId);
      db.prepare('DELETE FROM user_credits WHERE user_id = ?').run(ids.userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(ids.userId);
    }
  });
}

async function mutate(cookie, body, reason) {
  return request('/api/admin/knowledge', {
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
  const page = await request('/admin/knowledge', { headers: { cookie } });
  assert(page.res.status === 200, `knowledge page failed: ${page.res.status} ${page.text}`);
  assert(page.text.includes('/api/admin/knowledge'), 'knowledge page should be wired to /api/admin/knowledge');
  assert(!page.text.includes('P1-G 接入'), 'knowledge page should not render old placeholder');

  const fx = createProject();
  const cardIds = [];
  try {
    const list = await request('/api/admin/knowledge?module=style_bible', { headers: { cookie } });
    assert(list.res.status === 200, `knowledge list failed: ${list.res.status} ${list.text}`);
    assert(Array.isArray(list.json.cards) && Array.isArray(list.json.projects), 'knowledge list shape invalid');

    const title = `Smoke Style Rule ${Date.now()}`;
    const save = await mutate(cookie, {
      action: 'save_draft',
      module: 'style_bible',
      title,
      cardType: 'rule',
      tags: ['smoke'],
      dataJson: JSON.stringify({ rule: 'use tighter visual continuity in smoke test' }),
    }, 'knowledge smoke save draft');
    assert(save.res.status === 200, `save draft failed: ${save.res.status} ${save.text}`);
    const draftId = save.json.card.id;
    cardIds.push(draftId);
    assert(save.json.card.lifecycle === 'draft', 'save draft did not create draft lifecycle');

    const dryPreview = await mutate(cookie, {
      action: 'preview',
      cardId: draftId,
      projectId: fx.projectId,
      runModel: false,
      dryRun: true,
    }, 'knowledge smoke dry preview');
    assert(dryPreview.res.status === 200 && dryPreview.json.dryRun === true, `dry preview failed: ${dryPreview.res.status} ${dryPreview.text}`);

    const blockedPublish = await mutate(cookie, { action: 'publish', cardId: draftId }, 'knowledge smoke publish before real preview');
    assert(blockedPublish.res.status === 409, `publish should require non-dry-run preview, got ${blockedPublish.res.status} ${blockedPublish.text}`);

    const preview = await mutate(cookie, {
      action: 'preview',
      cardId: draftId,
      projectId: fx.projectId,
      runModel: false,
    }, 'knowledge smoke preview');
    assert(preview.res.status === 200, `preview failed: ${preview.res.status} ${preview.text}`);
    assert(preview.json.output && preview.json.mode === 'context_only', 'preview did not return context-only output');

    const publish = await mutate(cookie, { action: 'publish', cardId: draftId }, 'knowledge smoke publish');
    assert(publish.res.status === 200, `publish failed: ${publish.res.status} ${publish.text}`);
    const publishedId = publish.json.card.id;
    cardIds.push(publishedId);
    assert(publish.json.card.lifecycle === 'published', 'publish did not create published snapshot');
    const draft = withDb((db) => db.prepare('SELECT lifecycle FROM knowledge_cards WHERE id = ?').get(draftId));
    assert(draft.lifecycle === 'draft', 'publish should keep original draft as draft');

    const rollback = await mutate(cookie, { action: 'rollback', cardId: publishedId }, 'knowledge smoke rollback');
    assert(rollback.res.status === 200, `rollback failed: ${rollback.res.status} ${rollback.text}`);
    cardIds.push(rollback.json.card.id);
    assert(rollback.json.card.lifecycle === 'published', 'rollback did not create new published snapshot');
  } finally {
    cleanup({ cards: cardIds, projectId: fx.projectId, userId: fx.user.id });
  }

  console.log('admin knowledge smoke ok: draft, preview, publish, rollback are wired');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
