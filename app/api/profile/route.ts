import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getJson, setJson } from '@/lib/kv-db';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { DEFAULT_CREATOR_PROFILE, normalizeCreatorProfile } from '@/lib/creator-profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TABLE = 'user_profiles' as const;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  return jsonOk(normalizeCreatorProfile(getJson(TABLE, user.id, DEFAULT_CREATOR_PROFILE)));
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const hasProfilePayload = body && typeof body.profile === 'object' && body.profile !== null;
  const patch = hasProfilePayload ? body.profile : body;
  const isReset = hasProfilePayload && Object.keys(patch).length === 0;
  const cur = normalizeCreatorProfile(getJson(TABLE, user.id, DEFAULT_CREATOR_PROFILE));
  const now = new Date().toISOString();
  const merged = normalizeCreatorProfile({
    ...(isReset ? DEFAULT_CREATOR_PROFILE : cur),
    ...patch,
    updatedAt: now,
    lastUpdated: now,
  });
  setJson(TABLE, user.id, merged);
  return jsonOk(merged);
}

export async function POST(req: NextRequest) {
  return PUT(req);
}
