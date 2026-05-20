import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withAdminAudit } from '../lib/admin-audit';
import { signAdminToken } from '../lib/admin-auth';
import { getDb, type AdminUserRow } from '../lib/db';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = getDb();
  const username = process.env.ADMIN_SMOKE_USERNAME || 'origin-admin';
  const admin = db
    .prepare<{ username: string }, AdminUserRow>('SELECT * FROM admin_users WHERE username = @username')
    .get({ username });
  assert(admin, `admin user ${username} not found`);

  const token = await signAdminToken(admin);
  const idempotencyKey = randomUUID();
  const reason = 'admin audit wrapper throw smoke';
  const wrapped = withAdminAudit(async function throwForSmoke(_req, ctx) {
    ctx.setAuditTarget({ type: 'smoke', ids: ['throw'] });
    ctx.setAuditDiff({ before: { ok: true }, after: { ok: false } });
    throw new Error('intentional admin audit wrapper smoke error');
  }, 'audit.smoke.throw', {
    category: 'audit',
    requireReason: true,
    idempotent: true,
  });

  const req = new NextRequest('http://localhost:3000/api/admin/audit-smoke/throw', {
    method: 'POST',
    headers: {
      cookie: `admin_token=${encodeURIComponent(token)}`,
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      'x-idempotency-key': idempotencyKey,
      'x-admin-reason': reason,
    },
    body: JSON.stringify({ reason }),
  });
  const response = await wrapped(req);
  assert(response instanceof NextResponse || response instanceof Response, 'wrapped handler did not return a Response');
  assert(response.status === 500, `throwing wrapped handler should return 500, got ${response.status}`);

  const row = db
    .prepare(
      `SELECT status, response_status, error_msg, result_json
         FROM admin_actions
        WHERE action = 'audit.smoke.throw'
          AND idempotency_key = ?
          AND dry_run = 0
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(idempotencyKey) as { status: string; response_status: number; error_msg: string; result_json: string } | undefined;
  assert(row, 'throwing wrapped handler did not write an admin_actions row');
  assert(row.status === 'error', `throwing wrapped handler should finalize status=error, got ${row.status}`);
  assert(row.response_status === 500, `throwing wrapped handler should finalize response_status=500, got ${row.response_status}`);
  assert(/intentional admin audit wrapper smoke error/.test(row.error_msg || ''), 'throwing wrapped handler did not persist error_msg');

  console.log('admin audit wrapper smoke ok: handler throw finalizes audit row as error');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
