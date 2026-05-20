import { NextRequest } from 'next/server';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getCurrentAdmin, toPublicAdmin } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const admin = await getCurrentAdmin(req);
  if (!admin) return jsonError('unauthorized', 401);
  return jsonOk({ admin: toPublicAdmin(admin) });
}
