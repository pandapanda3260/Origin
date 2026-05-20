const baseUrl = process.env.ADMIN_SMOKE_BASE_URL || 'http://localhost:3000';
const username = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
const password = process.env.ADMIN_SMOKE_PASSWORD || 'origin-admin-dev-2026!';
const origin = process.env.ADMIN_SMOKE_ORIGIN || 'http://localhost:3000';
const dbPath = process.env.ADMIN_SMOKE_DB_PATH || 'data/qd.sqlite';

async function request(path, options = {}) {
  const res = await fetch(baseUrl + path, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function assertLoginRateLimit() {
  const ip = `203.0.113.${(Date.now() % 200) + 1}`;
  for (let i = 0; i < 5; i += 1) {
    const result = await request('/api/admin/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': ip,
      },
      body: JSON.stringify({ username, password: `wrong-password-${i}` }),
    });
    assert(result.res.status === 401, `failed login ${i + 1} should return 401, got ${result.res.status}`);
  }
  const blocked = await request('/api/admin/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
    },
    body: JSON.stringify({ username, password: 'wrong-password-blocked' }),
  });
  assert(blocked.res.status === 429, `sixth failed login should be rate-limited with 429, got ${blocked.res.status}`);
}

async function putBanner(cookie, body, idempotencyKey, reason) {
  return request('/api/maintenance/banner', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'x-idempotency-key': idempotencyKey,
      'x-admin-reason': reason,
    },
    body: JSON.stringify({ ...body, reason }),
  });
}

async function main() {
  await assertLoginRateLimit();
  const cookie = await login();
  const before = await request('/api/maintenance/banner');
  assert(before.res.status === 200, `read initial banner failed: ${before.res.status} ${before.text}`);
  const original = before.json || { enabled: false, message: '', startsAt: null, endsAt: null };

  const marker = `admin-audit-smoke-${Date.now()}`;
  const sharedKey = crypto.randomUUID();
  const planned = { enabled: true, message: marker, startsAt: null, endsAt: null };

  const dryRun = await putBanner(cookie, { ...planned, dryRun: true }, sharedKey, 'admin audit smoke dry-run');
  assert(dryRun.res.status === 200, `dry-run failed: ${dryRun.res.status} ${dryRun.text}`);
  assert(dryRun.json && dryRun.json.dryRun === true, 'dry-run did not return dryRun payload');

  const commit = await putBanner(cookie, planned, sharedKey, 'admin audit smoke commit after dry-run');
  assert(commit.res.status === 200, `commit after dry-run failed: ${commit.res.status} ${commit.text}`);
  assert(!(commit.json && commit.json.dryRun === true), 'commit replayed the dry-run payload instead of mutating');
  assert(commit.json && commit.json.message === marker, 'commit did not apply the banner mutation');

  const after = await request('/api/maintenance/banner');
  assert(after.res.status === 200, `read updated banner failed: ${after.res.status} ${after.text}`);
  assert(after.json && after.json.message === marker, 'banner state was not updated after commit');

  const replay = await putBanner(cookie, { enabled: false, message: 'should-not-apply', startsAt: null, endsAt: null }, sharedKey, 'admin audit smoke replay');
  assert(replay.res.status === 200, `real replay failed: ${replay.res.status} ${replay.text}`);
  assert(replay.json && replay.json.message === marker, 'real replay did not return the original committed payload');

  const concurrentKey = crypto.randomUUID();
  const concurrentMarker = `admin-audit-concurrent-${Date.now()}`;
  const concurrentResults = await Promise.all(
    Array.from({ length: 10 }, () => putBanner(
      cookie,
      { enabled: true, message: concurrentMarker, startsAt: null, endsAt: null },
      concurrentKey,
      'admin audit smoke concurrent commit',
    )),
  );
  const accepted = concurrentResults.filter((item) => item.res.status === 200);
  const inProgress = concurrentResults.filter((item) => item.res.status === 409);
  assert(accepted.length >= 1, 'concurrent idempotency test should have at least one accepted request');
  assert(accepted.length + inProgress.length === concurrentResults.length, 'concurrent idempotency returned unexpected status');
  assertCommittedAuditRowCount(concurrentKey, 1);

  const staleKey = crypto.randomUUID();
  insertIdempotencyClaim(staleKey, new Date(Date.now() - 6 * 60 * 1000).toISOString());
  const staleMarker = `admin-audit-stale-${Date.now()}`;
  const staleRetry = await putBanner(
    cookie,
    { enabled: true, message: staleMarker, startsAt: null, endsAt: null },
    staleKey,
    'admin audit smoke stale claim retry',
  );
  assert(staleRetry.res.status === 200, `stale in_progress retry should reclaim and commit, got ${staleRetry.res.status} ${staleRetry.text}`);
  assert(staleRetry.json && staleRetry.json.message === staleMarker, 'stale in_progress retry did not apply mutation');
  assertCommittedAuditRowCount(staleKey, 1);
  assertNoInProgressClaim(staleKey);

  const freshKey = crypto.randomUUID();
  insertIdempotencyClaim(freshKey, new Date().toISOString());
  const freshRetry = await putBanner(
    cookie,
    { enabled: true, message: 'fresh in-progress should not apply', startsAt: null, endsAt: null },
    freshKey,
    'admin audit smoke fresh claim conflict',
  );
  assert(freshRetry.res.status === 409, `fresh in_progress retry should return 409, got ${freshRetry.res.status} ${freshRetry.text}`);
  cleanupClaim(freshKey);

  const unauthorized = await request('/api/maintenance/banner', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-idempotency-key': crypto.randomUUID(),
      'x-admin-reason': 'admin audit smoke unauthorized',
    },
    body: JSON.stringify({ enabled: false, message: 'unauthorized should not apply' }),
  });
  assert(unauthorized.res.status === 401, `unauthorized admin write should return 401, got ${unauthorized.res.status}`);

  const restoreKey = crypto.randomUUID();
  const restore = await putBanner(cookie, original, restoreKey, 'admin audit smoke restore');
  assert(restore.res.status === 200, `restore failed: ${restore.res.status} ${restore.text}`);

  console.log('admin audit smoke ok: dry-run does not block commit, real idempotency replays committed payload');
}

function withDb(callback) {
  const fs = require('fs');
  if (!fs.existsSync(dbPath)) {
    console.warn(`skip admin_actions DB check; DB not found at ${dbPath}`);
    return undefined;
  }
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function insertIdempotencyClaim(idempotencyKey, createdAt) {
  withDb((db) => {
    db.prepare(
      `INSERT INTO admin_actions
        (id, request_id, admin_user_id, category, action, target_type, target_id, reason,
         dry_run, idempotency_key, before_json, after_json, result_json, response_status, status, error_msg, ip, user_agent, created_at)
       VALUES
        (?, ?, NULL, 'config', 'config.maintenance_banner.update', 'idempotency', ?, 'admin audit smoke inserted claim',
         0, ?, '{}', '{}', '{}', 102, 'in_progress', NULL, 'smoke', 'smoke-admin-audit', ?)`,
    ).run(crypto.randomUUID(), crypto.randomUUID(), idempotencyKey, idempotencyKey, createdAt);
  });
}

function assertNoInProgressClaim(idempotencyKey) {
  withDb((db) => {
    const row = db.prepare(
      `SELECT COUNT(*) AS c
         FROM admin_actions
        WHERE action = 'config.maintenance_banner.update'
          AND idempotency_key = ?
          AND dry_run = 0
          AND status = 'in_progress'`,
    ).get(idempotencyKey);
    assert(row && row.c === 0, `expected no stale in_progress audit row for ${idempotencyKey}, got ${row && row.c}`);
  });
}

function cleanupClaim(idempotencyKey) {
  withDb((db) => {
    db.prepare(
      `UPDATE admin_actions
          SET status = 'error',
              error_msg = COALESCE(error_msg, 'smoke cleanup'),
              response_status = 409
        WHERE action = 'config.maintenance_banner.update'
          AND idempotency_key = ?
          AND dry_run = 0
          AND status = 'in_progress'`,
    ).run(idempotencyKey);
  });
}

function assertCommittedAuditRowCount(idempotencyKey, expected) {
  withDb((db) => {
    const row = db.prepare(
      `SELECT COUNT(*) AS c
         FROM admin_actions
        WHERE action = 'config.maintenance_banner.update'
          AND idempotency_key = ?
          AND dry_run = 0
          AND status = 'completed'`,
    ).get(idempotencyKey);
    assert(row && row.c === expected, `expected ${expected} committed audit row for ${idempotencyKey}, got ${row && row.c}`);
  });
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
