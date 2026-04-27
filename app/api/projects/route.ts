import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { createProjectForUser, listProjectsByUser } from '@/lib/projects-db';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const items = listProjectsByUser(user.id);
  // 原站前端兼容：同时给出 projects 和 items 两个字段名
  return jsonOk({ projects: items, items, total: items.length });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const project = createProjectForUser(user.id, body);
  return jsonOk(project);
}
