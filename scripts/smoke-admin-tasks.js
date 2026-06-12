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
    ).get(`task_smoke_${suffix}`, `task_smoke_${suffix}@example.test`, 'Task Smoke User', hashSync(crypto.randomUUID(), 10));
    db.prepare(
      `INSERT INTO user_credits (user_id, total_credits, bonus_credits)
       VALUES (?, 1000, 1000)`,
    ).run(user.id);
    const projectId = `proj_task_smoke_${suffix}`;
    const batchId = `batch_task_smoke_${suffix}`;
    const taskId = `bt_task_smoke_${suffix}`;
    const videoTaskId = `video_task_smoke_${suffix}`;
    const exportId = `export_task_smoke_${suffix}`;

    db.prepare(
      `INSERT INTO projects (id, owner_id, title, description, status)
       VALUES (?, ?, 'Task Smoke Project', '', 'draft')`,
    ).run(projectId, user.id);
    db.prepare(
      `INSERT INTO batches (id, owner_id, project_id, batch_type, status, total, succeeded, failed)
       VALUES (?, ?, ?, 'storyboard_images', 'running', 1, 0, 0)`,
    ).run(batchId, user.id, projectId);
    db.prepare(
      `INSERT INTO batch_tasks (id, batch_id, seq, task_type, status, status_reason, result_json, retry_count, max_retries)
       VALUES (?, ?, 1, 'storyboard_image', 'needs_review', 'smoke review', '{}', 0, 3)`,
    ).run(taskId, batchId);
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, charge_ref_id, balance_after)
       VALUES (?, ?, -20, 'image', 'smoke charge', ?, ?, 980)`,
    ).run(`ledger_charge_${suffix}`, user.id, taskId, `charge:${taskId}`);
    db.prepare(
      `INSERT INTO video_tasks (id, owner_id, project_id, prompt, provider, provider_task, status, progress)
       VALUES (?, ?, ?, 'task smoke prompt', 'fake', ?, 'running', 40)`,
    ).run(videoTaskId, user.id, projectId, `provider_video_${suffix}`);
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, charge_ref_id, balance_after)
       VALUES (?, ?, -150, 'video', 'smoke video charge', ?, ?, 830)`,
    ).run(`ledger_video_charge_${suffix}`, user.id, videoTaskId, `charge:${videoTaskId}`);
    db.prepare(
      `INSERT INTO exports (id, owner_id, project_id, status, progress, provider, external_export_id, edl_json)
       VALUES (?, ?, ?, 'running', 30, 'local', ?, '{}')`,
    ).run(exportId, user.id, projectId, `provider_export_${suffix}`);
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reason, ref_id, charge_ref_id, balance_after)
       VALUES (?, ?, -5, 'export', 'smoke export charge', ?, ?, 825)`,
    ).run(`ledger_export_charge_${suffix}`, user.id, exportId, `charge:${exportId}`);
    return { user, projectId, batchId, taskId, videoTaskId, exportId };
  });
}

function cleanupFixtures(fx) {
  withDb((db) => {
    db.prepare('DELETE FROM task_state_history WHERE task_id = ?').run(fx.taskId);
    db.prepare('DELETE FROM admin_actions WHERE target_id LIKE ? OR target_id = ?').run(`%${fx.taskId}%`, fx.videoTaskId);
    db.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(fx.user.id);
    db.prepare('DELETE FROM exports WHERE id = ?').run(fx.exportId);
    db.prepare('DELETE FROM video_tasks WHERE id = ?').run(fx.videoTaskId);
    db.prepare('DELETE FROM batch_tasks WHERE batch_id = ?').run(fx.batchId);
    db.prepare('DELETE FROM batches WHERE id = ?').run(fx.batchId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(fx.projectId);
    db.prepare('DELETE FROM user_credits WHERE user_id = ?').run(fx.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(fx.user.id);
  });
}

async function mutate(cookie, body, reason) {
  const key = crypto.randomUUID();
  return request('/api/admin/tasks', {
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

function readRow(table, id) {
  return withDb((db) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
}

async function main() {
  const cookie = await login();
  // 任务管理已并入问题队列首页（2026-06 瘦身）。
  const page = await request('/admin', { headers: { cookie } });
  assert(page.res.status === 200, `admin home (merged tasks) page failed: ${page.res.status} ${page.text}`);
  assert(page.text.includes('/api/admin/tasks'), 'home page should be wired to /api/admin/tasks');
  assert(page.text.includes('data-task-search="true"'), 'home page should render the merged task toolbar');
  assert(page.text.includes('id="needsReview"'), 'home page should render the needs_review card');

  const fx = createFixtures();
  try {
    const list = await request(`/api/admin/tasks?q=${encodeURIComponent(fx.batchId)}`, { headers: { cookie } });
    assert(list.res.status === 200, `task list failed: ${list.res.status} ${list.text}`);
    assert(list.json.items.some((item) => item.source === 'batch' && item.id === fx.batchId), 'task list did not include batch');
    assert(list.json.items.some((item) => item.source === 'batch_task' && item.id === fx.taskId), 'task list did not include batch task');

    const dryRetry = await mutate(cookie, { source: 'batch_task', id: fx.taskId, action: 'retry', dryRun: true }, 'task smoke dry retry');
    assert(dryRetry.res.status === 200, `dry retry failed: ${dryRetry.res.status} ${dryRetry.text}`);
    assert(dryRetry.json && dryRetry.json.dryRun === true, 'dry retry did not return dryRun payload');
    assert(readRow('batch_tasks', fx.taskId).status === 'needs_review', 'dry retry mutated batch task');

    const retry = await mutate(cookie, { source: 'batch_task', id: fx.taskId, action: 'retry' }, 'task smoke retry');
    assert(retry.res.status === 200, `retry failed: ${retry.res.status} ${retry.text}`);
    assert(readRow('batch_tasks', fx.taskId).status === 'queued', 'retry did not set batch task queued');

    const forceFail = await mutate(cookie, { source: 'video_task', id: fx.videoTaskId, action: 'force_fail' }, 'task smoke force fail');
    assert(forceFail.res.status === 200, `video force_fail failed: ${forceFail.res.status} ${forceFail.text}`);
    const video = readRow('video_tasks', fx.videoTaskId);
    assert(video.status === 'failed' && String(video.error_message || '').includes('task smoke force fail'), 'video force_fail did not persist failure');
    assert(video.admin_disposition === 'force_failed' && video.refund_checked_at, 'video force_fail did not persist admin disposition/refund check');
    const videoRefund = withDb((db) => db.prepare(
      `SELECT amount FROM credit_ledger WHERE user_id = ? AND kind = 'refund' AND refund_ref_id = ?`,
    ).get(fx.user.id, `refund:${fx.videoTaskId}`));
    assert(videoRefund && Number(videoRefund.amount) === 150, 'video force_fail did not auto-refund');

    const cancelExport = await mutate(cookie, { source: 'export', id: fx.exportId, action: 'cancel' }, 'task smoke cancel export');
    assert(cancelExport.res.status === 200, `export cancel failed: ${cancelExport.res.status} ${cancelExport.text}`);
    assert(cancelExport.json?.result?.localCancel, 'export cancel did not report localCancel result');
    assert(!('providerCancel' in (cancelExport.json?.result || {})), 'export cancel should not report providerCancel when only local cancellation is performed');
    assert(cancelExport.json.result.localCancel.providerCancelAttempted === false, 'export cancel should be explicit that provider cancel was not attempted');
    const exportRow = readRow('exports', fx.exportId);
    assert(exportRow.status === 'cancelled', 'export cancel did not persist cancelled');
    assert(exportRow.cancel_requested_at && exportRow.cancelled_local_at && exportRow.admin_disposition === 'cancelled_local', 'export cancel did not persist local cancellation fields');
    const exportRefund = withDb((db) => db.prepare(
      `SELECT amount FROM credit_ledger WHERE user_id = ? AND kind = 'refund' AND refund_ref_id = ?`,
    ).get(fx.user.id, `refund:${fx.exportId}`));
    assert(exportRefund && Number(exportRefund.amount) === 5, 'export cancel did not auto-refund');

    const refund = await mutate(cookie, { source: 'batch_task', id: fx.taskId, action: 'refund_check' }, 'task smoke refund check');
    assert(refund.res.status === 200, `refund check failed: ${refund.res.status} ${refund.text}`);
    const refunded = withDb((db) => db.prepare(
      `SELECT amount FROM credit_ledger WHERE user_id = ? AND kind = 'refund' AND refund_ref_id = ?`,
    ).get(fx.user.id, `refund:${fx.taskId}`));
    assert(refunded && Number(refunded.amount) === 20, 'refund_check did not create expected refund ledger');
  } finally {
    cleanupFixtures(fx);
  }

  console.log('admin tasks smoke ok: aggregate list and task actions are wired');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
