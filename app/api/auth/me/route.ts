import { NextRequest } from 'next/server';
import { getCurrentUser, userToPublic } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  return jsonOk(userToPublic(user));
}
