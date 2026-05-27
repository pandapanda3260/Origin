import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import {
  availableFirstFrameReferenceTileIds,
  buildFirstFrameDraftWithReferenceSelection,
  buildFirstFrameMaterialPanel,
  currentFirstFrameEditDraft,
  firstFrameDraftFingerprint,
  nextFirstFrameReferenceMaterialsVersion,
  normalizeFirstFrameReferenceMaterials,
  reconcileFirstFramePromptStateInPatch,
  validateAndNormalizeFirstFrameDraft,
  type FirstFrameReferenceAttachment,
  type FirstFrameReferenceMaterial,
  FirstFrameDraftValidationException,
} from '@/lib/first-frame-edit-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function cleanIdList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function conflictResponse(message: string, code: string, extra: Record<string, unknown> = {}) {
  return Response.json(
    {
      error: message,
      code,
      ...extra,
    },
    { status: 409 },
  );
}

function validationResponse(errors: Array<{ field: string; message: string }>) {
  return Response.json(
    {
      error: errors[0]?.message || 'validation_failed',
      code: 'validation_failed',
      errors,
    },
    { status: 422 },
  );
}

function attachmentToMaterial(item: FirstFrameReferenceAttachment): FirstFrameReferenceMaterial | null {
  if (!item?.id || !item.imageId || !item.role || !item.url) return null;
  return {
    id: item.id,
    imageId: item.imageId,
    role: item.role,
    ...(item.name ? { name: item.name } : {}),
    url: item.url,
    thumbUrl: item.thumbUrl || item.url,
    uploadedAt: item.uploadedAt || new Date(0).toISOString(),
    uploadedBy: item.uploadedBy || 0,
  };
}

function draftWithoutReferenceAttachments(draft: any) {
  if (!draft || typeof draft !== 'object') return draft;
  const { firstFrameReferenceAttachments: _legacyAttachments, ...rest } = draft;
  return rest;
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const groupIdx = parseGroupIdx(body?.groupIdx);
  const includeIds = cleanIdList(body?.includeIds);
  const baseSourceHash = String(body?.baseSourceHash || '').trim();
  const baseSelectionVersion = String(body?.baseSelectionVersion || '').trim();

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  try {
    let draft: any = null;
    let sourceHash: string | null = null;
    let savedDraftFingerprint = '';
    let firstFrameMaterialPanel: unknown = null;
    const updated = patchProjectForUser(projectId, user.id, (fresh) => {
      if (!fresh) return null;
      const promptState = reconcileFirstFramePromptStateInPatch({ project: fresh, user, groupIdx });
      sourceHash = promptState.sourceHash;
      const { draft: currentDraft } = currentFirstFrameEditDraft(fresh, groupIdx);
      const panel = buildFirstFrameMaterialPanel({
        project: fresh,
        userId: user.id,
        plan: promptState.plan,
        draft: currentDraft,
        sourceHash,
      });
      if (baseSourceHash && baseSourceHash !== sourceHash) {
        throw Object.assign(new Error('reference_source_changed'), {
          status: 409,
          code: 'reference_source_changed',
          panel,
        });
      }
      if (baseSelectionVersion && baseSelectionVersion !== panel.selectionVersion) {
        throw Object.assign(new Error('reference_selection_changed'), {
          status: 409,
          code: 'reference_selection_changed',
          panel,
        });
      }
      if (includeIds.length > panel.cap) {
        throw Object.assign(new Error(`已达模型参考图上限 ${panel.cap} 张`), {
          status: 422,
          code: 'reference_cap_reached',
        });
      }
      const legacyAttachments = Array.isArray(currentDraft?.firstFrameReferenceAttachments)
        ? currentDraft.firstFrameReferenceAttachments
        : [];
      const existingMaterials = normalizeFirstFrameReferenceMaterials(fresh);
      const materialKeys = new Set(existingMaterials.flatMap((item) => [item.id, item.imageId].filter(Boolean)));
      const migratedMaterials = legacyAttachments
        .map(attachmentToMaterial)
        .filter((item): item is FirstFrameReferenceMaterial => !!item)
        .filter((item) => {
          if (materialKeys.has(item.id) || materialKeys.has(item.imageId)) return false;
          materialKeys.add(item.id);
          materialKeys.add(item.imageId);
          return true;
        });
      const materialsChanged = migratedMaterials.length > 0;
      const nextMaterials = materialsChanged ? [...migratedMaterials, ...existingMaterials] : existingMaterials;
      const materialVersion = materialsChanged
        ? nextFirstFrameReferenceMaterialsVersion()
        : String((fresh as any).firstFrameReferenceMaterialsVersion || '');
      const projectForSelection = materialsChanged
        ? {
          ...fresh,
          firstFrameReferenceMaterials: nextMaterials,
          firstFrameReferenceMaterialsVersion: materialVersion,
        }
        : fresh;
      const baseDraftForSelection = draftWithoutReferenceAttachments(currentDraft);
      const available = new Set(availableFirstFrameReferenceTileIds({
        project: projectForSelection,
        userId: user.id,
        plan: promptState.plan,
        draft: baseDraftForSelection,
      }));
      const invalidIds = includeIds.filter((id) => !available.has(id));
      if (invalidIds.length) {
        throw Object.assign(new Error('部分参考图已不可用，请刷新后重试。'), {
          status: 409,
          code: 'reference_selection_unavailable',
          invalidIds,
          panel,
        });
      }
      draft = buildFirstFrameDraftWithReferenceSelection({
        baseDraft: baseDraftForSelection,
        sourceHash,
        userId: user.id,
        includeIds,
        project: projectForSelection,
        plan: promptState.plan,
      });
      validateAndNormalizeFirstFrameDraft({
        project: projectForSelection,
        groupIdx,
        userId: user.id,
        input: draft,
        plan: promptState.plan,
      });
      savedDraftFingerprint = firstFrameDraftFingerprint(draft);
      firstFrameMaterialPanel = buildFirstFrameMaterialPanel({
        project: projectForSelection,
        userId: user.id,
        plan: promptState.plan,
        draft,
        sourceHash,
      });
      const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
      const prev = storyboards[groupIdx] || {};
      storyboards[groupIdx] = {
        ...prev,
        ...(promptState.slotPatch || {}),
        firstFrameEditDraft: draft,
      };
      return {
        storyboards,
        ...(materialsChanged ? {
          firstFrameReferenceMaterials: nextMaterials,
          firstFrameReferenceMaterialsVersion: materialVersion,
        } : {}),
      };
    });

    return jsonOk({
      ok: true,
      draft,
      sourceHash,
      savedDraftFingerprint,
      baselineFingerprint: savedDraftFingerprint,
      firstFrameMaterialPanel,
      projectUpdatedAt: (updated as any)?.updatedAt || null,
    });
  } catch (err: any) {
    if (err instanceof FirstFrameDraftValidationException) return validationResponse(err.errors);
    if (err?.status === 409) {
      return conflictResponse(
        err.code === 'reference_source_changed'
          ? '参考素材已变更，请刷新后继续。'
          : err.message || '参考素材状态已更新，请确认后重试。',
        err.code || 'reference_selection_changed',
        {
          invalidIds: err.invalidIds || undefined,
          firstFrameMaterialPanel: err.panel || undefined,
        },
      );
    }
    if (err?.status === 422) {
      return Response.json(
        { error: err.message || 'reference_selection_invalid', code: err.code || 'validation_failed' },
        { status: 422 },
      );
    }
    return jsonError(err?.message || '保存参考图选择失败', 500);
  }
}
