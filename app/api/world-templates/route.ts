import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  listWorldTemplateSummaries,
  listWorldTemplates,
  upsertWorldTemplate,
} from '@/lib/world-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const full = req.nextUrl.searchParams.get('full') === '1';
  const templates = full ? listWorldTemplates(user.id) : listWorldTemplateSummaries(user.id);
  return jsonOk({ templates, items: templates, total: templates.length });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const template = upsertWorldTemplate(user.id, body.template || body);
  return jsonOk({ ok: true, template });
}
