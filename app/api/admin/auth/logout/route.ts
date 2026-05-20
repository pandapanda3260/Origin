import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/api-helpers';
import { withAdminAudit } from '@/lib/admin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAdminAudit(async function logoutAdmin(_req: NextRequest) {
  const resp = jsonOk({ ok: true });
  resp.cookies.set('admin_token', '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return resp;
}, 'admin.self.logout', {
  category: 'admin_self',
  safe: true,
  idempotent: true,
});
