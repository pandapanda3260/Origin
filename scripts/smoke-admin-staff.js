const Database = require('better-sqlite3');

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

async function login(loginUsername = username, loginPassword = password, expectedStatus = 200) {
  const result = await request('/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: loginUsername, password: loginPassword }),
  });
  assert(result.res.status === expectedStatus, `admin login expected ${expectedStatus}, got ${result.res.status} ${result.text}`);
  if (expectedStatus !== 200) return '';
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

async function createStaff(cookie, body, reason) {
  return request('/api/admin/staff', {
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

async function mutateStaff(cookie, body, reason) {
  return request('/api/admin/staff', {
    method: 'PATCH',
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

async function changeSelfPassword(cookie, body) {
  return request('/api/admin/staff/self-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'x-idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

function cleanupAdmin(adminId) {
  if (!adminId) return;
  withDb((db) => {
    const row = db.prepare('SELECT preview_user_id FROM admin_users WHERE id = ?').get(adminId);
    db.prepare('DELETE FROM admin_users WHERE id = ?').run(adminId);
    if (row?.preview_user_id) {
      db.prepare('DELETE FROM user_credits WHERE user_id = ?').run(row.preview_user_id);
      db.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(row.preview_user_id);
      db.prepare('DELETE FROM users WHERE id = ?').run(row.preview_user_id);
    }
  });
}

async function main() {
  const cookie = await login();
  const page = await request('/admin/staff', { headers: { cookie } });
  assert(page.res.status === 200, `staff page failed: ${page.res.status} ${page.text}`);
  assert(page.text.includes('data-staff-table="true"'), 'staff page should render staff table');
  assert(page.text.includes('/api/admin/staff'), 'staff page should be wired to /api/admin/staff');
  assert(!page.text.includes('P1-B 接入'), 'staff page should not render the old placeholder panel');

  const list = await request('/api/admin/staff', { headers: { cookie } });
  assert(list.res.status === 200, `list staff failed: ${list.res.status} ${list.text}`);
  assert(list.json && Array.isArray(list.json.items), 'list staff did not return items');
  assert(list.json.items.some((item) => item.username === username && item.previewUserId), 'seed admin should have previewUserId');

  const staffUsername = `staff_smoke_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const initialPassword = 'Staff-smoke-password-2026!';
  const resetPassword = 'Staff-smoke-reset-2026!';
  const selfPassword = 'Staff-smoke-self-2026!';
  let createdAdminId = null;
  try {
    const dryRun = await createStaff(cookie, {
      username: staffUsername,
      password: initialPassword,
      dryRun: true,
    }, 'admin staff smoke dry-run create');
    assert(dryRun.res.status === 200, `staff dry-run failed: ${dryRun.res.status} ${dryRun.text}`);
    assert(dryRun.json && dryRun.json.dryRun === true, 'staff dry-run did not return dryRun payload');

    const created = await createStaff(cookie, {
      username: staffUsername,
      password: initialPassword,
    }, 'admin staff smoke create');
    assert(created.res.status === 200, `staff create failed: ${created.res.status} ${created.text}`);
    createdAdminId = created.json.admin.id;
    assert(created.json.admin.previewUserId, 'created admin did not get previewUserId');

    const row = withDb((db) => db.prepare(
      `SELECT au.id, au.username, au.preview_user_id, u.username AS shadow_username, u.email, u.email_verified
         FROM admin_users au
         JOIN users u ON u.id = au.preview_user_id
        WHERE au.id = ?`,
    ).get(createdAdminId));
    assert(row && row.shadow_username === `__shadow__${createdAdminId}`, `unexpected shadow username: ${row && row.shadow_username}`);
    assert(row.email === null, 'shadow user email should be null');
    assert(row.email_verified === 1, 'shadow user should be email_verified=1');

    const targetCookie = await login(staffUsername, initialPassword);
    const meBeforeRevoke = await request('/api/admin/auth/me', { headers: { cookie: targetCookie } });
    assert(meBeforeRevoke.res.status === 200, `target admin should be logged in before revoke, got ${meBeforeRevoke.res.status}`);

    const revoke = await mutateStaff(cookie, { action: 'revoke_tokens', adminId: createdAdminId }, 'admin staff smoke revoke tokens');
    assert(revoke.res.status === 200, `revoke tokens failed: ${revoke.res.status} ${revoke.text}`);
    const meAfterRevoke = await request('/api/admin/auth/me', { headers: { cookie: targetCookie } });
    assert(meAfterRevoke.res.status === 401, `revoked target cookie should be unauthorized, got ${meAfterRevoke.res.status}`);

    const resetDryRun = await mutateStaff(cookie, {
      action: 'reset_password',
      adminId: createdAdminId,
      newPassword: resetPassword,
      dryRun: true,
    }, 'admin staff smoke dry-run reset password');
    assert(resetDryRun.res.status === 200, `reset dry-run failed: ${resetDryRun.res.status} ${resetDryRun.text}`);
    assert(resetDryRun.json && resetDryRun.json.dryRun === true, 'reset dry-run did not return dryRun payload');

    const reset = await mutateStaff(cookie, {
      action: 'reset_password',
      adminId: createdAdminId,
      newPassword: resetPassword,
    }, 'admin staff smoke reset password');
    assert(reset.res.status === 200, `reset password failed: ${reset.res.status} ${reset.text}`);
    const resetCookie = await login(staffUsername, resetPassword);

    const selfDryRun = await changeSelfPassword(resetCookie, {
      oldPassword: resetPassword,
      newPassword: selfPassword,
      dryRun: true,
    });
    assert(selfDryRun.res.status === 200, `self password dry-run failed: ${selfDryRun.res.status} ${selfDryRun.text}`);
    assert(selfDryRun.json && selfDryRun.json.dryRun === true, 'self password dry-run did not return dryRun payload');

    const selfChange = await changeSelfPassword(resetCookie, {
      oldPassword: resetPassword,
      newPassword: selfPassword,
    });
    assert(selfChange.res.status === 200, `self password change failed: ${selfChange.res.status} ${selfChange.text}`);
    await login(staffUsername, selfPassword);

    const disable = await mutateStaff(cookie, { action: 'disable', adminId: createdAdminId }, 'admin staff smoke disable');
    assert(disable.res.status === 200, `disable admin failed: ${disable.res.status} ${disable.text}`);
    await login(staffUsername, selfPassword, 401);
  } finally {
    cleanupAdmin(createdAdminId);
  }

  console.log('admin staff smoke ok: create/shadow/revoke/reset/self-change/disable are wired');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
