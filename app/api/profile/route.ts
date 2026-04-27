import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getJson, setJson } from '@/lib/kv-db';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TABLE = 'user_profiles' as const;

const DEFAULT = {
  visualStyle: '',
  narrativeStyle: '',
  cameraStyle: '',
  moodStyle: '',
  promptHabits: '',
  rawDialog: [] as { role: string; content: string }[],
  updatedAt: null as string | null,
};

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  return jsonOk(getJson(TABLE, user.id, DEFAULT));
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const cur = getJson(TABLE, user.id, DEFAULT) as any;
  const merged = { ...cur, ...body, updatedAt: new Date().toISOString() };
  setJson(TABLE, user.id, merged);
  return jsonOk(merged);
}

export async function POST(req: NextRequest) {
  return PUT(req);
}
