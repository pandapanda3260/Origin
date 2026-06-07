import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  confirmCustomCharacterDraft,
  getCustomCharacterForUser,
  listCustomCharacterVersions,
  serializeCustomCharacter,
} from '@/lib/custom-character-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const versionId = String(body.versionId || '').trim();
  if (!versionId) return jsonError('请选择要添加的角色版本', 400);
  const nameOverride = String(body.name || '').trim();
  try {
    const character = confirmCustomCharacterDraft(user.id, params.id, versionId, nameOverride);
    const versions = listCustomCharacterVersions(character.id, user.id);
    const current = versions.find((item: any) => item.id === character.current_version_id)?.fields || null;
    return jsonOk({
      ok: true,
      character: serializeCustomCharacter(character, current ? JSON.stringify(current) : null),
      versions,
    });
  } catch (error: any) {
    const existing = getCustomCharacterForUser(params.id, user.id);
    const status = existing && existing.lifecycle_status === 'confirmed' ? 409 : 400;
    return jsonError(error?.message || '确认添加失败，请重新生成后再试', status);
  }
}
