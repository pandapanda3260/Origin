import { NextRequest } from 'next/server';
import { requireUser, revokeUserTokens } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    revokeUserTokens(user.id);
    return jsonOk({ ok: true });
  } catch {
    return jsonError('unauthorized', 401);
  }
}
