import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { batchPreflightPayload } from '@/lib/batch-preflight';
import { getProjectByIdForUser } from '@/lib/projects-db';
import {
  availableFirstFrameAssets,
  buildFirstFrameMaterialPanel,
  buildFirstFramePlanPreview,
  currentFirstFrameEditDraft,
  effectiveFirstFrameReferences,
  firstFrameDraftFingerprint,
  isFirstFrameEditDraftStale,
  LEGACY_STYLE_RULE_NOTICE_MESSAGE,
} from '@/lib/first-frame-edit-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseGroupIdx(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function firstFrameUrl(sb: any): string {
  return String(sb?.frames?.first?.url || sb?.firstFrameUrl || sb?.imageUrl || sb?.rawUrl || sb?.url || '').trim();
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const groupIdx = parseGroupIdx(url.searchParams.get('groupIdx'));
  const frameType = String(url.searchParams.get('frameType') || 'first_frame');

  if (!projectId) return jsonError('缺 projectId', 400);
  if (groupIdx == null) return jsonError('缺 groupIdx', 400);
  if (frameType !== 'first_frame') return jsonError('当前仅支持 first_frame', 400);

  const project = getProjectByIdForUser(projectId, user.id);
  if (!project) return jsonError('项目不存在', 404);

  const storyboards = Array.isArray((project as any).storyboards) ? (project as any).storyboards : [];
  const sb = storyboards[groupIdx] || {};
  const currentUrl = firstFrameUrl(sb);
  const imageHistory = Array.isArray(sb.imageHistory) ? sb.imageHistory : [];
  const legacyUnsupported = String(sb.firstFrameMode || '') === 'legacy_pencil';

  if (legacyUnsupported) {
    const { draft } = currentFirstFrameEditDraft(project, groupIdx);
    const sourceHash = sb.firstFrameSourceHash || sb.frames?.first?.sourceHash || null;
    const savedDraftFingerprint = firstFrameDraftFingerprint(sourceHash, draft);
    return jsonOk({
      projectId,
      groupIdx,
      frameType,
      legacyUnsupported: true,
      message: '旧版手稿首帧没有结构化生成计划，请先点击“重新生成”升级为彩色首帧后再使用编辑控制台。',
      sourceHash,
      draft,
      savedDraftFingerprint,
      baselineFingerprint: savedDraftFingerprint,
      currentFrame: {
        url: currentUrl,
        mode: sb.firstFrameMode || '',
        status: sb.firstFrame?.status || sb.frames?.first?.status || '',
        sourceHash,
      },
      imageHistory,
    });
  }

  const preview = buildFirstFramePlanPreview({
    project,
    groupIdx,
    ownerId: user.id,
    user,
  });
  const { draft, didMigrate } = currentFirstFrameEditDraft(project, groupIdx);
  const savedDraftFingerprint = firstFrameDraftFingerprint(preview.sourceHash, draft);
  const effectiveReferences = effectiveFirstFrameReferences(project, user.id, preview.plan, draft);
  const firstFrameMaterialPanel = buildFirstFrameMaterialPanel({
    project,
    userId: user.id,
    plan: preview.plan,
    draft,
    sourceHash: preview.sourceHash,
  });
  const preflight = batchPreflightPayload(project, projectId, 'storyboard_images', [{
    groupIdx,
    idx: groupIdx,
    shotIndices: preview.shotIndices,
  }]);

  return jsonOk({
    projectId,
    groupIdx,
    frameType,
    legacyUnsupported: false,
    sourceHash: preview.sourceHash,
    draft,
    ...(didMigrate ? {
      notices: [{
        code: 'legacy_style_rules_merged',
        message: LEGACY_STYLE_RULE_NOTICE_MESSAGE,
      }],
    } : {}),
    savedDraftFingerprint,
    baselineFingerprint: savedDraftFingerprint,
    draftStale: !!(draft && isFirstFrameEditDraftStale(draft.sourceHash, preview.sourceHash)),
    currentFrame: {
      url: currentUrl,
      mode: sb.firstFrameMode || sb.frames?.first?.mode || '',
      status: sb.firstFrame?.status || sb.frames?.first?.status || (currentUrl ? 'ready' : 'missing'),
      sourceHash: sb.firstFrameSourceHash || sb.frames?.first?.sourceHash || null,
      prompt: sb.firstFramePrompt || sb.frames?.first?.prompt || '',
      planSummary: sb.firstFramePlanSummary || sb.frames?.first?.planSummary || null,
    },
    imageHistory,
    plan: {
      finalPrompt: preview.plan.finalPrompt,
      planSummary: preview.planSummary,
      modelSnapshot: preview.modelSnapshot,
      primaryShotIdx: preview.plan.primaryShotIdx,
      primaryShot: preview.plan.primaryShot,
      contextShotIndices: preview.plan.contextShotIndices,
      contextShots: preview.plan.contextShots,
      styleLock: preview.plan.styleLock,
      characterLockText: preview.plan.characterLockText,
      sceneLockText: preview.plan.sceneLockText,
      propLockText: preview.plan.propLockText,
      driftGuardrails: preview.plan.driftGuardrails,
      compositionGuidance: preview.plan.compositionGuidance,
      referenceManifest: preview.plan.referenceManifest,
      effectiveReferenceManifest: effectiveReferences.manifest,
      firstFrameMaterialPanel,
    },
    firstFrameMaterialPanel,
    availableAssets: availableFirstFrameAssets(project),
    preflight,
  });
}
