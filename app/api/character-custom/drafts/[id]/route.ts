import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { deleteCustomCharacterDraft } from '@/lib/custom-character-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const deleted = deleteCustomCharacterDraft(user.id, params.id);
  return jsonOk({ ok: true, deleted });
}
