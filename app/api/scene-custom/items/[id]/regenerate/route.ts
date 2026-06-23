import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  createCustomSceneVersion,
  finalizeCustomSceneVersion,
  getCurrentCustomSceneVersion,
  getCustomSceneForUser,
  promoteCustomSceneVersion,
  serializeCustomSceneVersion,
} from '@/lib/custom-scene-db';
import {
  normalizeCustomSceneEditableFields,
  toFriendlySceneError,
  type CustomSceneSourceType,
} from '@/lib/custom-scene-prompt';
import {
  generateCustomSceneEstablishing,
  supportsReferenceImageGeneration,
} from '@/lib/custom-scene-generation';
import { resolveLLMConfig } from '@/lib/llm';
import { resolveLocalImagePath } from '@/lib/image-gen';
import { resolveSceneImageUrl } from '@/lib/scene-views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failedRegenerateSceneData(previous: any, error: any, attemptUrl?: string) {
  const now = new Date().toISOString();
  const friendlyMessage = toFriendlySceneError(error);
  const next: any = {
    ...(previous || {}),
    reference: {
      ...((previous && previous.reference) || {}),
      status: 'failed',
      lastAttemptUrl: attemptUrl || previous?.reference?.lastAttemptUrl || '',
      lastFailedAt: now,
      updatedAt: now,
      lastError: {
        reason: 'custom_scene_regeneration_failed',
        message: friendlyMessage,
        rawMessage: String(error?.message || error || friendlyMessage).slice(0, 1000),
      },
    },
    imageFailedAt: now,
    imageLastError: friendlyMessage,
  };
  delete next.imageUrl;
  delete next.rawUrl;
  delete next.assetId;
  return next;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const scene = getCustomSceneForUser(params.id, user.id);
  if (!scene) return jsonError('场景不存在', 404);
  const currentVersion = getCurrentCustomSceneVersion(scene);
  if (!currentVersion) return jsonError('场景还没有可重新生成的当前版本', 409);
  const body = await req.json().catch(() => ({} as any));
  const previous = JSON.parse(currentVersion.scene_data_json || '{}');
  const fields = normalizeCustomSceneEditableFields(previous, body.fields || {});
  const projectId = scene.project_id || null;
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const cfg = resolveLLMConfig(user, 'image');
  const referenceCandidate = resolveSceneImageUrl(fields, { viewRole: 'establishing', gate: true });
  const referenceImagePath = supportsReferenceImageGeneration(cfg)
    ? (resolveLocalImagePath(referenceCandidate, user.id) || undefined)
    : undefined;
  const sourceType: CustomSceneSourceType = referenceImagePath ? 'image_prompt' : 'prompt';

  const placeholder = createCustomSceneVersion({
    ownerId: user.id,
    projectId,
    sceneId: scene.id,
    title: fields.name || scene.title,
    generationStatus: 'running',
    sourceType,
    prompt: '',
    params: {},
    inputRefs: [],
    sceneData: fields,
    makeCurrent: false,
  });
  const assetRef = `custom-scene/${scene.id}/versions/${placeholder.version_no}/views/establishing`;

  try {
    const generated = await generateCustomSceneEstablishing({
      user,
      fields,
      styleBible: (project as any)?.styleBible || {},
      projectId,
      assetRef,
      sourceType,
      referenceImagePath,
    });
    const version = finalizeCustomSceneVersion({
      versionId: placeholder.id,
      ownerId: user.id,
      generationStatus: 'completed',
      sceneData: generated.sceneData,
      resultImageId: generated.result.id,
      title: generated.sceneData.name || fields.name || scene.title,
    });
    promoteCustomSceneVersion(user.id, scene.id, version.id, generated.sceneData.name || scene.title);
    return jsonOk(signCustomCharacterImageUrls({
      ok: true,
      sceneId: scene.id,
      version: serializeCustomSceneVersion(version),
      referenceStatus: 'ready',
      accepted: true,
    }, user.id));
  } catch (error: any) {
    const sceneData = failedRegenerateSceneData(fields, error);
    const version = finalizeCustomSceneVersion({
      versionId: placeholder.id,
      ownerId: user.id,
      generationStatus: 'failed',
      sceneData,
      resultImageId: null,
      errorMessage: sceneData.imageLastError,
      title: sceneData.name || scene.title,
    });
    return jsonOk(signCustomCharacterImageUrls({
      ok: false,
      sceneId: scene.id,
      version: serializeCustomSceneVersion(version),
      error: sceneData.imageLastError,
    }, user.id));
  }
}
