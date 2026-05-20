import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  return jsonError('knowledge cards user write API is not enabled', 404);
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  return jsonError('knowledge cards user write API is not enabled', 404);
}
