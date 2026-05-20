const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const username = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
const password = process.env.ADMIN_SMOKE_PASSWORD || 'origin-admin-dev-2026!';
const origin = process.env.ADMIN_SMOKE_ORIGIN || 'http://localhost:3000';
const dataDir = process.env.ORIGIN_DATA_DIR || process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbPath = process.env.ADMIN_SMOKE_DB_PATH || 'data/qd.sqlite';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}) {
  const res = await fetch(baseUrl + pathname, options);
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

async function mutate(cookie, path, body, reason) {
  return request(path, {
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

function withDb(callback) {
  const db = new Database(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

async function main() {
  const cookie = await login();
  for (const pagePath of ['/admin/config', '/admin/key-pool', '/admin/storage']) {
    const page = await request(pagePath, { headers: { cookie } });
    assert(page.res.status === 200, `${pagePath} failed: ${page.res.status} ${page.text}`);
  }

  const cfg = await request('/api/admin/config', { headers: { cookie } });
  assert(cfg.res.status === 200, `config GET failed: ${cfg.res.status} ${cfg.text}`);
  assert(typeof cfg.json.registration_enabled === 'boolean', 'config missing registration_enabled');
  const next = {
    registration_enabled: cfg.json.registration_enabled,
    video_generation_enabled: cfg.json.video_generation_enabled,
    export_enabled: cfg.json.export_enabled,
    global_video_concurrency_limit: cfg.json.global_video_concurrency_limit,
    global_image_concurrency_limit: cfg.json.global_image_concurrency_limit,
    maintenance_banner: cfg.json.maintenance_banner,
  };
  const dryConfig = await mutate(cookie, '/api/admin/config', { config: next, dryRun: true }, 'system smoke dry config');
  assert(dryConfig.res.status === 200 && dryConfig.json.dryRun === true, `config dry-run failed: ${dryConfig.res.status} ${dryConfig.text}`);
  const commitConfig = await mutate(cookie, '/api/admin/config', { config: next }, 'system smoke config');
  assert(commitConfig.res.status === 200, `config commit failed: ${commitConfig.res.status} ${commitConfig.text}`);

  const metricId = `obs_system_smoke_${Date.now()}`;
  withDb((db) => db.prepare(
    `INSERT INTO observability_events
      (id, type, slot, provider, model, status, status_code, error_code, latency_ms, fallback_used, message, meta_json)
     VALUES
      (?, 'model_call', 'brain', 'smoke-provider', 'smoke-model', 'failed', 500, 'smoke_error', 123, 0, 'system smoke model failure', '{}')`,
  ).run(metricId));
  try {
    const keyPool = await request('/api/admin/key-pool/status', { headers: { cookie } });
    assert(keyPool.res.status === 200, `key pool failed: ${keyPool.res.status} ${keyPool.text}`);
    assert(Array.isArray(keyPool.json.pools), 'key pool missing pools');
    const brain = keyPool.json.pools.find((pool) => pool.name === 'brain');
    assert(brain && brain.metrics && brain.metrics.total >= 1 && brain.metrics.failed >= 1, 'key pool did not include observability metrics');
  } finally {
    withDb((db) => db.prepare('DELETE FROM observability_events WHERE id = ?').run(metricId));
  }

  const logId = `obs_system_log_smoke_${Date.now()}`;
  withDb((db) => db.prepare(
    `INSERT INTO observability_events
      (id, type, slot, provider, model, status, message, meta_json)
     VALUES
      (?, 'system_warn', NULL, NULL, NULL, 'warn', 'system smoke persistent warning', '{}')`,
  ).run(logId));
  try {
    const logs = await request('/api/admin/logs?level=warning&lines=20', { headers: { cookie } });
    assert(logs.res.status === 200, `admin logs failed: ${logs.res.status} ${logs.text}`);
    assert((logs.json.lines || []).some((line) => line.includes('system smoke persistent warning')), 'admin logs did not include persistent observability warning');
  } finally {
    withDb((db) => db.prepare('DELETE FROM observability_events WHERE id = ?').run(logId));
  }

  const ownerId = `storage_smoke_${Date.now()}`;
  const ownerDir = path.join(dataDir, 'uploads', ownerId);
  fs.mkdirSync(ownerDir, { recursive: true });
  const filename = 'orphan.txt';
  const filePath = path.join(ownerDir, filename);
  fs.writeFileSync(filePath, 'orphan smoke');
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, old, old);
  try {
    const storage = await request('/api/admin/storage?minAgeHours=0', { headers: { cookie } });
    assert(storage.res.status === 200, `storage GET failed: ${storage.res.status} ${storage.text}`);
    assert(storage.json.orphanFiles.some((f) => f.ownerId === ownerId && f.filename === filename), 'storage scan did not find orphan file');
    const dryStorage = await mutate(cookie, '/api/admin/storage', { action: 'quarantine_orphans', minAgeHours: 0, dryRun: true }, 'system smoke dry quarantine');
    assert(dryStorage.res.status === 200 && dryStorage.json.dryRun === true, `storage dry-run failed: ${dryStorage.res.status} ${dryStorage.text}`);
    assert(dryStorage.json.candidateHash, 'storage dry-run did not return candidateHash');
    assert(fs.existsSync(filePath), 'storage dry-run moved file');

    const extraFilename = 'orphan-extra.txt';
    const extraPath = path.join(ownerDir, extraFilename);
    fs.writeFileSync(extraPath, 'orphan smoke extra');
    fs.utimesSync(extraPath, old, old);
    const mismatch = await mutate(cookie, '/api/admin/storage', {
      action: 'quarantine_orphans',
      minAgeHours: 0,
      candidateHash: dryStorage.json.candidateHash,
    }, 'system smoke quarantine stale hash');
    assert(mismatch.res.status === 409, `storage stale candidateHash should be 409, got ${mismatch.res.status}`);
    fs.rmSync(extraPath, { force: true });

    const dryStorage2 = await mutate(cookie, '/api/admin/storage', { action: 'quarantine_orphans', minAgeHours: 0, dryRun: true }, 'system smoke dry quarantine second');
    assert(dryStorage2.res.status === 200 && dryStorage2.json.candidateHash, `second storage dry-run failed: ${dryStorage2.res.status} ${dryStorage2.text}`);
    const quarantine = await mutate(cookie, '/api/admin/storage', {
      action: 'quarantine_orphans',
      minAgeHours: 0,
      candidateHash: dryStorage2.json.candidateHash,
    }, 'system smoke quarantine');
    assert(quarantine.res.status === 200, `storage quarantine failed: ${quarantine.res.status} ${quarantine.text}`);
    assert(!fs.existsSync(filePath), 'storage quarantine did not move file');
  } finally {
    fs.rmSync(path.join(dataDir, 'uploads', ownerId), { recursive: true, force: true });
  }

  console.log('admin system smoke ok: config, key-pool, and storage quarantine are wired');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
