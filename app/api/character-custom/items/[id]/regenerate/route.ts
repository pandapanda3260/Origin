import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser } from '@/lib/projects-db';
import {
  createCustomCharacterVersion,
  getCurrentCustomCharacterVersion,
  getCustomCharacterForUser,
  getNextCustomCharacterVersionNo,
  serializeCustomCharacterVersion,
} from '@/lib/custom-character-db';
import {
  buildCustomCharacterImagePrompt,
  normalizeCustomCharacterEditableFields,
  toFriendlyCharacterError,
  type CustomCharacterSourceType,
} from '@/lib/custom-character-prompt';
import { generateImageWithModerationRecovery } from '@/lib/safe-image-gen';
import { splitCharacterPanels } from '@/lib/character-panels';
import { deriveCharacterReferenceUpdate } from '@/lib/character-reference-update';
import { resolveLLMConfig } from '@/lib/llm';
import { resolveLocalImagePath } from '@/lib/image-gen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function supportsReferenceImageGeneration(cfg: any): boolean {
  const provider = String(cfg?.provider || '');
  const model = String(cfg?.model || '').toLowerCase();
  return provider === 'volcengine_seedream' || model.includes('gpt-image') || model.includes('dall-e-2');
}

function entityTypeOf(fields: any): 'human' | 'non-human' {
  return fields?.entityType === 'non-human' ? 'non-human' : 'human';
}

function sourceImageUrl(fields: any) {
  return String(fields?.imageUrl || fields?.rawUrl || fields?.realPhotoUrl || '').trim();
}

function fieldsForPrompt(fields: any) {
  if (entityTypeOf(fields) !== 'human') return fields;
  return {
    ...fields,
    castingOverride: {
      ...(fields?.castingOverride && typeof fields.castingOverride === 'object' ? fields.castingOverride : {}),
      ethnicityType: 'unspecified',
    },
  };
}

function failedRegenerateFields(previous: any, error: any, attemptUrl?: string) {
  const now = new Date().toISOString();
  const friendlyMessage = toFriendlyCharacterError(error);
  const next: any = {
    ...(previous || {}),
    reference: {
      ...((previous && previous.reference) || {}),
      status: 'failed',
      lastAttemptUrl: attemptUrl || previous?.reference?.lastAttemptUrl || '',
      lastFailedAt: now,
      updatedAt: now,
      lastError: {
        reason: 'custom_character_regeneration_failed',
        message: friendlyMessage,
        rawMessage: String(error?.message || error || friendlyMessage).slice(0, 1000),
      },
    },
    imageFailedAt: now,
    imageLastError: friendlyMessage,
  };
  delete next.imageUrl;
  delete next.rawUrl;
  delete next.realPhotoUrl;
  delete next.pencilUrl;
  delete next.originalUrl;
  delete next.displayUrl;
  delete next.thumbUrl;
  delete next.pencilOriginalUrl;
  delete next.pencilDisplayUrl;
  delete next.pencilThumbUrl;
  delete next.panels;
  return next;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const character = getCustomCharacterForUser(params.id, user.id);
  if (!character) return jsonError('角色不存在', 404);
  if (character.lifecycle_status !== 'confirmed') return jsonError('只有已添加的角色才能重新生成', 409);
  const currentVersion = getCurrentCustomCharacterVersion(character);
  if (!currentVersion) return jsonError('角色还没有可重新生成的当前版本', 409);

  const body = await req.json().catch(() => ({} as any));
  const previousFields = JSON.parse(currentVersion.fields_json || '{}');
  const fields = normalizeCustomCharacterEditableFields(previousFields, body.fields || {});
  const projectId = character.project_id || null;
  const project = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  const rawStyleBible = (project as any)?.styleBible || {};
  const script = (project as any)?.script || (project as any)?.scriptDraft || '';
  const cfg = resolveLLMConfig(user, 'image');
  const referenceCandidate = sourceImageUrl(fields);
  const referenceImagePath = supportsReferenceImageGeneration(cfg)
    ? (resolveLocalImagePath(referenceCandidate, user.id) || undefined)
    : undefined;
  const sourceType: CustomCharacterSourceType = referenceImagePath ? 'image_prompt' : 'prompt';
  const versionNo = getNextCustomCharacterVersionNo(character.id, user.id);
  const assetRef = `custom/${character.id}/versions/${versionNo}`;

  try {
    const { prompt: imagePrompt, styleLockContext } = buildCustomCharacterImagePrompt({
      fields: fieldsForPrompt(fields),
      styleBible: rawStyleBible,
      script,
      sourceType,
    });
    const styleMeta = {
      styleBibleSignature: styleLockContext.signature,
      styleLockVersion: styleLockContext.styleLockVersion,
      resolvedBackdropColor: styleLockContext.resolvedBackdropColor,
    };
    const result = await generateImageWithModerationRecovery(user, {
      prompt: imagePrompt,
      size: '1536x1024',
      style: 'natural',
      kind: 'character',
      entityType: entityTypeOf(fields),
      projectId: projectId || undefined,
      assetRef,
      quality: 'medium',
      referenceImagePath,
      styleLockApplied: styleLockContext.hasMeaningfulStyle,
      styleBackdropColor: styleLockContext.resolvedBackdropColor,
      imageAuditMetadata: {
        styleBibleSignature: styleMeta.styleBibleSignature,
        styleBibleSignatureType: styleLockContext.signatureType,
        resolvedBackdropColor: styleMeta.resolvedBackdropColor || null,
        styleLockVersion: styleMeta.styleLockVersion,
        source: 'custom_character_regenerate',
      },
      assetLibrary: {
        stage: 'custom_character',
        source: 'generated',
        makeCurrent: false,
      },
    });

    const panelResult = await splitCharacterPanels({
      user,
      projectId,
      assetRef,
      sourceImageUrl: result.url,
      entityType: entityTypeOf(fields),
      prompt: result.submittedPrompt,
      version: versionNo,
    });
    const referenceUpdate = deriveCharacterReferenceUpdate(fields, result, panelResult, entityTypeOf(fields), styleMeta);

    if (!referenceUpdate.accepted) {
      const failedFields = failedRegenerateFields(fields, referenceUpdate.lastError || '角色设定图切片失败', result.url);
      const failedVersion = createCustomCharacterVersion({
        ownerId: user.id,
        projectId,
        characterId: character.id,
        title: fields.name || character.title,
        status: 'failed',
        sourceType,
        prompt: '',
        params: {},
        inputRefs: [],
        fields: failedFields,
        resultImageId: result.id,
        errorMessage: failedFields.imageLastError,
        makeCurrent: false,
      });
      return jsonOk({
        ok: false,
        characterId: character.id,
        version: serializeCustomCharacterVersion(failedVersion),
        error: failedFields.imageLastError,
        referenceStatus: 'failed',
      });
    }

    const nextFields = {
      ...referenceUpdate.nextAsset,
      id: character.id,
      imagePrompt: fields.imagePrompt,
      submittedImagePrompt: result.submittedPrompt,
      imageSafetyAudit: result.safetyAudit,
      effectiveVisualDescription: result.visualAnchorDescription,
    };
    const version = createCustomCharacterVersion({
      ownerId: user.id,
      projectId,
      characterId: character.id,
      title: nextFields.name || fields.name || character.title,
      status: 'completed',
      sourceType,
      prompt: '',
      params: {},
      inputRefs: [],
      fields: nextFields,
      resultImageId: result.id,
    });

    return jsonOk({
      ok: true,
      characterId: character.id,
      version: serializeCustomCharacterVersion(version),
      referenceStatus: referenceUpdate.referenceStatus,
      accepted: referenceUpdate.accepted,
      panelError: panelResult.ok ? null : panelResult.error,
    });
  } catch (error: any) {
    const failedFields = failedRegenerateFields(fields, error);
    const failedVersion = createCustomCharacterVersion({
      ownerId: user.id,
      projectId,
      characterId: character.id,
      title: fields.name || character.title,
      status: 'failed',
      sourceType,
      prompt: '',
      params: {},
      inputRefs: [],
      fields: failedFields,
      resultImageId: null,
      errorMessage: failedFields.imageLastError,
      makeCurrent: false,
    });
    return jsonOk({
      ok: false,
      characterId: character.id,
      version: serializeCustomCharacterVersion(failedVersion),
      error: failedFields.imageLastError,
    });
  }
}
