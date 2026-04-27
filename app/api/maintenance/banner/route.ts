import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT = { enabled: false, message: '', startsAt: null as string | null, endsAt: null as string | null };

export async function GET() {
  return jsonOk(readBanner());
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  if (!user.is_admin) return jsonError('forbidden', 403);
  const body = await req.json().catch(() => ({} as any));
  const v = {
    enabled: !!body.enabled,
    message: String(body.message || '').slice(0, 500),
    startsAt: body.startsAt || null,
    endsAt: body.endsAt || null,
  };
  saveBanner(v);
  return jsonOk(v);
}

function readBanner() {
  const db = getDb();
  const row = db.prepare<[], any>(`SELECT value_json FROM system_config WHERE key='maintenance_banner'`).get();
  if (!row) return DEFAULT;
  try { return { ...DEFAULT, ...JSON.parse(row.value_json) }; } catch { return DEFAULT; }
}
function saveBanner(v: any) {
  const db = getDb();
  const json = JSON.stringify(v);
  db.prepare(
    `INSERT INTO system_config (key, value_json, updated_at)
     VALUES ('maintenance_banner', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(json);
}
