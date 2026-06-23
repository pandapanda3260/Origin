import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  confirmCustomSceneDraft,
  getCustomSceneForUser,
  listCustomSceneVersions,
  serializeCustomScene,
} from '@/lib/custom-scene-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));
  const versionId = String(body.versionId || '').trim();
  if (!versionId) return jsonError('请选择要添加的场景版本', 400);
  const titleOverride = String(body.title || body.name || '').trim();
  try {
    const scene = confirmCustomSceneDraft(user.id, params.id, versionId, titleOverride);
    const versions = listCustomSceneVersions(scene.id, user.id);
    const current = versions.find((item: any) => item.id === scene.current_version_id)?.sceneData || null;
    return jsonOk(signCustomCharacterImageUrls({
      ok: true,
      scene: serializeCustomScene(scene, current ? JSON.stringify(current) : null),
      versions,
    }, user.id));
  } catch (error: any) {
    const existing = getCustomSceneForUser(params.id, user.id);
    const status = existing && existing.lifecycle_status === 'confirmed' ? 409 : 400;
    return jsonError(error?.message || '确认添加失败，请重新生成后再试', status);
  }
}
