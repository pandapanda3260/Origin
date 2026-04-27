import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getJson, setJson } from '@/lib/kv-db';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { MOCK_USER_SETTINGS } from '@/mocks/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TABLE = 'user_settings' as const;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const data = getJson(TABLE, user.id, MOCK_USER_SETTINGS);
  return jsonOk(data);
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const cur = getJson(TABLE, user.id, MOCK_USER_SETTINGS) as any;
  const merged = {
    ...cur,
    ...body,
    updatedAt: new Date().toISOString(),
  };
  setJson(TABLE, user.id, merged);
  return jsonOk(merged);
}

export async function POST(req: NextRequest) {
  return PUT(req);
}
