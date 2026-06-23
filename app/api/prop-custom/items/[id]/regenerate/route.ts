import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { signCustomCharacterImageUrls } from '@/lib/custom-character-image-urls';
import {
  createCustomPropVersion,
  finalizeCustomPropVersion,
  getCurrentCustomPropVersion,
  getCustomPropForUser,
  promoteCustomPropVersion,
  serializeCustomPropVersion,
} from '@/lib/custom-prop-db';
import {
  normalizeCustomPropEditableFields,
  toFriendlyPropError,
  type CustomPropSourceType,
} from '@/lib/custom-prop-prompt';
import {
  generateCustomPropImage,
  referenceImagePathForProp,
  supportsReferenceImageGeneration,
} from '@/lib/custom-prop-generation';
import { resolveLLMConfig } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failedRegeneratePropData(previous: any, error: any, attemptUrl?: string) {
  const now = new Date().toISOString();
  const friendlyMessage = toFriendlyPropError(error);
  const next: any = {
    ...(previous || {}),
    reference: {
      ...((previous && previous.reference) || {}),
      status: 'failed',
      lastAttemptUrl: attemptUrl || previous?.reference?.lastAttemptUrl || '',
      lastFailedAt: now,
      updatedAt: now,
      lastError: {
        reason: 'custom_prop_regeneration_failed',
        message: friendlyMessage,
        rawMessage: String(error?.message || error || friendlyMessage).slice(0, 1000),
      },
    },
    imageFailedAt: now,
    imageLastError: friendlyMessage,
  };
  delete next.imageUrl;
  delete next.rawUrl;
  delete next.originalUrl;
  delete next.displayUrl;
  return next;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const prop = getCustomPropForUser(params.id, user.id);
  if (!prop) return jsonError('道具不存在', 404);
  if (prop.lifecycle_status !== 'confirmed') return jsonError('只有已添加的道具才能重新生成', 409);
  const currentVersion = getCurrentCustomPropVersion(prop);
  if (!currentVersion) return jsonError('道具还没有可重新生成的当前版本', 409);

  const body = await req.json().catch(() => ({} as any));
  const previous = JSON.parse(currentVersion.prop_data_json || '{}');
  const fields = normalizeCustomPropEditableFields(previous, body.fields || {});
  const projectId = prop.project_id || null;
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const cfg = resolveLLMConfig(user, 'image');
  const referenceImagePath = supportsReferenceImageGeneration(cfg)
    ? referenceImagePathForProp(fields, user.id)
    : undefined;
  const sourceType: CustomPropSourceType = referenceImagePath ? 'image_prompt' : 'prompt';

  const placeholder = createCustomPropVersion({
    ownerId: user.id,
    projectId,
    propId: prop.id,
    title: fields.name || prop.title,
    generationStatus: 'running',
    sourceType,
    prompt: '',
    params: {},
    inputRefs: [],
    propData: fields,
    makeCurrent: false,
  });
  const assetRef = `custom-prop/${prop.id}/versions/${placeholder.version_no}`;

  try {
    const generated = await generateCustomPropImage({
      user,
      fields,
      styleBible: (project as any)?.styleBible || {},
      projectId,
      assetRef,
      sourceType,
      referenceImagePath,
      version: placeholder.version_no,
    });
    const version = finalizeCustomPropVersion({
      versionId: placeholder.id,
      ownerId: user.id,
      generationStatus: 'completed',
      propData: generated.propData,
      resultImageId: generated.result.id,
      errorMessage: generated.splitResult && !generated.splitResult.ok ? generated.splitResult.error : null,
      title: generated.propData.name || fields.name || prop.title,
    });
    if (generated.accepted) {
      promoteCustomPropVersion(user.id, prop.id, version.id, generated.propData.name || prop.title);
    }
    return jsonOk(signCustomCharacterImageUrls({
      ok: generated.accepted,
      propId: prop.id,
      version: serializeCustomPropVersion(version),
      referenceStatus: generated.referenceStatus,
      accepted: generated.accepted,
      viewsError: generated.splitResult && !generated.splitResult.ok ? generated.splitResult.error : undefined,
    }, user.id));
  } catch (error: any) {
    const propData = failedRegeneratePropData(fields, error);
    const version = finalizeCustomPropVersion({
      versionId: placeholder.id,
      ownerId: user.id,
      generationStatus: 'failed',
      propData,
      resultImageId: null,
      errorMessage: propData.imageLastError,
      title: propData.name || prop.title,
    });
    return jsonOk(signCustomCharacterImageUrls({
      ok: false,
      propId: prop.id,
      version: serializeCustomPropVersion(version),
      error: propData.imageLastError,
    }, user.id));
  }
}
