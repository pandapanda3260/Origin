import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  deleteCustomSceneForUser,
  getCustomSceneForUser,
  getCurrentCustomSceneVersion,
  listCustomSceneVersions,
  serializeCustomScene,
  serializeCustomSceneVersion,
  updateCustomSceneVersionData,
} from '@/lib/custom-scene-db';
import { normalizeCustomSceneEditableFields } from '@/lib/custom-scene-prompt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const scene = getCustomSceneForUser(params.id, user.id);
  if (!scene) return jsonError('场景不存在', 404);
  const versions = listCustomSceneVersions(scene.id, user.id);
  const current = versions.find((item: any) => item.id === scene.current_version_id)?.sceneData || null;
  return jsonOk(signCustomCharacterImageUrls({
    ok: true,
    scene: serializeCustomScene(scene, current ? JSON.stringify(current) : null),
    versions,
  }, user.id));
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const scene = getCustomSceneForUser(params.id, user.id);
  if (!scene) return jsonError('场景不存在', 404);
  const deleted = deleteCustomSceneForUser(user.id, scene.id);
  if (!deleted) return jsonError('场景删除失败，请刷新页面后再试', 409);
  return jsonOk({ ok: true, sceneId: scene.id });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const scene = getCustomSceneForUser(params.id, user.id);
  if (!scene) return jsonError('场景不存在', 404);
  const currentVersion = getCurrentCustomSceneVersion(scene);
  if (!currentVersion) return jsonError('场景还没有可编辑的当前版本', 409);
  const body = await req.json().catch(() => ({} as any));
  const previous = JSON.parse(currentVersion.scene_data_json || '{}');
  const sceneData = normalizeCustomSceneEditableFields(previous, body.fields || body);
  const updated = updateCustomSceneVersionData(currentVersion.id, user.id, sceneData, sceneData.name || scene.title);
  return jsonOk(signCustomCharacterImageUrls({
    ok: true,
    sceneId: scene.id,
    version: serializeCustomSceneVersion(updated),
  }, user.id));
}
