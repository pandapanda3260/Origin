import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  getCurrentCustomSceneVersion,
  getCustomSceneForUser,
  serializeCustomSceneVersion,
  updateCurrentCustomSceneVersionData,
} from '@/lib/custom-scene-db';
import { generateCustomSceneFollowupView } from '@/lib/custom-scene-generation';
import { toFriendlySceneError } from '@/lib/custom-scene-prompt';
import { normalizeSceneViewRole, resolveSceneImageUrl } from '@/lib/scene-views';
import type { SceneViewQualityRole } from '@/lib/scene-view-quality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function followupRole(value: string): SceneViewQualityRole | null {
  const role = normalizeSceneViewRole(value);
  return role === 'topdown' || role === 'reverse' || role === 'alt' ? role : null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string; role: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const role = followupRole(params.role);
  if (!role) return jsonError('只支持重新生成 topdown / reverse / alt 场景副视图', 400);

  const scene = getCustomSceneForUser(params.id, user.id);
  if (!scene) return jsonError('场景不存在', 404);
  const currentVersion = getCurrentCustomSceneVersion(scene);
  if (!currentVersion) return jsonError('场景还没有可重新生成的当前版本', 409);
  if (currentVersion.generation_status !== 'completed') return jsonError('当前场景版本还没有生成完成', 409);
  const sceneData = JSON.parse(currentVersion.scene_data_json || '{}');
  if (!resolveSceneImageUrl(sceneData, { viewRole: 'establishing', gate: true })) {
    return jsonError('请先生成场景主视图，再生成副视图', 409);
  }

  const projectId = scene.project_id || null;
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const assetRef = `custom-scene/${scene.id}/versions/${currentVersion.version_no}/views/${role}`;
  try {
    const generated = await generateCustomSceneFollowupView({
      user,
      sceneData,
      role,
      styleBible: (project as any)?.styleBible || {},
      projectId,
      assetRef,
      tokenContext: {
        requestPath: req.nextUrl.pathname,
        routeName: 'scene-custom.view-regenerate',
        callItemType: 'custom_scene_version',
        callItemId: currentVersion.id,
        callItemLabel: `${scene.title}.views.${role}`,
      },
    });
    const updated = updateCurrentCustomSceneVersionData({
      ownerId: user.id,
      sceneId: scene.id,
      sceneData: generated.sceneData,
      resultImageId: generated.result.id,
      title: generated.sceneData.name || scene.title,
    });
    return jsonOk(signCustomCharacterImageUrls({
      ok: true,
      sceneId: scene.id,
      role,
      version: serializeCustomSceneVersion(updated),
      referencePlan: generated.referencePlan,
      qualityAudit: generated.qualityAudit,
    }, user.id));
  } catch (error: any) {
    console.error('[scene-custom] view regenerate failed:', error?.message || error);
    return jsonOk({
      ok: false,
      sceneId: scene.id,
      role,
      error: toFriendlySceneError(error),
    });
  }
}
