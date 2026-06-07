import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  deleteCustomCharacterForUser,
  getCustomCharacterForUser,
  getCurrentCustomCharacterVersion,
  listCustomCharacterVersions,
  serializeCustomCharacter,
  serializeCustomCharacterVersion,
  updateCustomCharacterVersionFields,
} from '@/lib/custom-character-db';
import { normalizeCustomCharacterEditableFields } from '@/lib/custom-character-prompt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const character = getCustomCharacterForUser(params.id, user.id);
  if (!character) return jsonError('角色不存在', 404);
  const versions = listCustomCharacterVersions(character.id, user.id);
  const current = versions.find((item: any) => item.id === character.current_version_id)?.fields || null;
  return jsonOk(signCustomCharacterImageUrls({
    ok: true,
    character: serializeCustomCharacter(character, current ? JSON.stringify(current) : null),
    versions,
  }, user.id));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const character = getCustomCharacterForUser(params.id, user.id);
  if (!character) return jsonError('角色不存在', 404);
  const deleted = deleteCustomCharacterForUser(user.id, character.id);
  if (!deleted) return jsonError('角色删除失败，请刷新页面后再试', 409);
  return jsonOk({ ok: true, characterId: character.id });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const character = getCustomCharacterForUser(params.id, user.id);
  if (!character) return jsonError('角色不存在', 404);
  if (character.lifecycle_status !== 'confirmed') return jsonError('只有已添加的角色才能编辑字段', 409);
  const currentVersion = getCurrentCustomCharacterVersion(character);
  if (!currentVersion) return jsonError('角色还没有可编辑的当前版本', 409);
  const body = await req.json().catch(() => ({} as any));
  const previous = JSON.parse(currentVersion.fields_json || '{}');
  const fields = normalizeCustomCharacterEditableFields(previous, body.fields || body);
  const updated = updateCustomCharacterVersionFields(currentVersion.id, user.id, fields, fields.name || character.title);
  return jsonOk(signCustomCharacterImageUrls({
    ok: true,
    characterId: character.id,
    version: serializeCustomCharacterVersion(updated),
  }, user.id));
}
