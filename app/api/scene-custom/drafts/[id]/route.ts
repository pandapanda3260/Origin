import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { deleteCustomSceneDraft } from '@/lib/custom-scene-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const deleted = deleteCustomSceneDraft(user.id, params.id);
  return jsonOk({ ok: true, deleted });
}
