import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';
import { buildStyleBibleMessages } from '@/lib/prompts';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import { sinicizeColorPalette } from '@/lib/style-bible';
import { sanitizePromptObject } from '@/lib/content-sanitize';
import { hashNormalizedScript } from '@/lib/script-style-state';
import { setRecentWorldStyleMapping } from '@/lib/style-templates-db';
import {
  buildStyleBibleConstraintsFromTemplate,
  mergeStyleBibleWithConstraints,
  normalizeLLMStyleBibleOutput,
  styleTemplateHashOf,
  type StyleConstraints,
} from '@/lib/style-template-constraints';
import {
  buildWorldContextFromSnapshot,
  worldTemplateHashOf,
  type WorldContext,
} from '@/lib/world-template-context';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import { maybeInjectKnowledgePromptBlock } from '@/lib/knowledge/inject-messages';
import type { KnowledgeContextForStage } from '@/lib/knowledge/types';
import {
  createStyleBibleRun,
  ensureStyleBibleRunWorker,
  getLatestStyleBibleRunForProject,
  getStyleBibleRunByRunId,
  parseStyleBibleRunDraft,
  parseStyleBibleRunInput,
} from '@/lib/style-bible-runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STYLE_BIBLE_LOCK_TTL_MS = 30 * 60 * 1000;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  ensureStyleBibleRunWorker();

  const projectId = req.nextUrl.searchParams.get('projectId') || '';
  const runId = req.nextUrl.searchParams.get('runId') || '';
  if (!projectId) return jsonError('缺少 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);
  const row = runId
    ? getStyleBibleRunByRunId(runId)
    : getLatestStyleBibleRunForProject(user.id, projectId);
  const latestRow = runId ? getLatestStyleBibleRunForProject(user.id, projectId) : row;
  const runStatus = row?.status || '';
  const runActive = runStatus === 'queued' || runStatus === 'running' || runStatus === 'retry_pending';
  const runFailed = runStatus === 'failed' || runStatus === 'cancelled';
  const runCompleted = runStatus === 'completed';
  const statusRow = runActive || runFailed ? row : null;
  if (row && runCompleted) {
    const completed = completedStyleBiblePayload(row, proj, row.run_id === latestRow?.run_id);
    return jsonOk(completed);
  }
  return jsonOk({
    styleBibleStatus: runActive ? 'generating' : runFailed ? 'failed' : ((proj as any).styleBibleStatus || ''),
    styleBibleError: runActive ? (statusRow?.error_message || '') : runFailed ? (statusRow?.error_message || '风格圣经生成失败') : ((proj as any).styleBibleError || ''),
    styleBibleErrorCode: statusRow ? (statusRow.error_code || null) : ((proj as any).styleBibleErrorCode || null),
    styleBibleRunId: runActive ? (statusRow?.run_id || null) : ((proj as any).styleBibleRunId || null),
    styleBibleStage: row?.stage || (proj as any).styleBibleStage || null,
    styleBibleProgress: runActive ? progressForStatusStage(statusRow?.stage || '') : ((proj as any).styleBibleProgress ?? null),
    styleBibleNextRetryAt: runActive ? (statusRow?.next_retry_at || null) : ((proj as any).styleBibleNextRetryAt || row?.next_retry_at || null),
    styleBibleHeartbeatAt: runActive ? (statusRow?.heartbeat_at || null) : ((proj as any).styleBibleHeartbeatAt || row?.heartbeat_at || null),
    styleBibleStartedAt: runActive ? (statusRow?.started_at || statusRow?.created_at || null) : ((proj as any).styleBibleStartedAt || row?.started_at || null),
    styleBibleGeneratedAt: (proj as any).styleBibleGeneratedAt || null,
    styleBible: (proj as any).styleBible || null,
    run: row ? {
      runId: row.run_id,
      status: row.status,
      stage: row.stage,
      attempt: row.attempt,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      nextRetryAt: row.next_retry_at,
      heartbeatAt: row.heartbeat_at,
      completedAt: row.completed_at,
    } : null,
  });
}

function completedStyleBiblePayload(row: any, proj: any, shouldHealProject: boolean) {
  const draft = parseStyleBibleRunDraft(row);
  const hasDraft = isRecord(draft) && Object.keys(draft).length > 0;
  const input = parseStyleBibleRunInput(row);
  const generatedAt = row.completed_at || row.updated_at || row.created_at || new Date().toISOString();
  const styleBible = hasDraft ? draft : ((proj as any).styleBible || null);
  if (shouldHealProject && hasDraft && shouldHealCompletedStyleBibleMirror(proj, draft, generatedAt)) {
    try {
      patchProjectForUser(row.project_id, row.owner_id, () => ({
        allowStyleBibleRunOverwrite: true,
        styleBible: draft,
        styleBibleStatus: 'ready',
        styleBibleError: '',
        styleBibleErrorCode: null,
        styleBibleGeneratedAt: generatedAt,
        styleBibleSource: 'generated',
        styleBibleRunId: null,
        styleBibleStartedAt: null,
        styleBibleStage: null,
        styleBibleProgress: 100,
        styleBibleNextRetryAt: null,
        styleBibleHeartbeatAt: null,
        styleBibleSourceHash: input.styleBibleSourceHash || null,
        styleBibleGenerationContext: input.styleBibleGenerationContext || null,
        styleBibleStaleReason: null,
        styleBibleStaleSince: null,
        styleBibleManuallyEditedAt: null,
      }));
    } catch (error) {
      console.warn('[style-bible] completed mirror self-heal skipped:', error);
    }
  }
  return {
    styleBibleStatus: 'ready',
    styleBibleError: '',
    styleBibleErrorCode: null,
    styleBibleRunId: null,
    styleBibleStage: row.stage || null,
    styleBibleProgress: 100,
    styleBibleNextRetryAt: null,
    styleBibleHeartbeatAt: null,
    styleBibleStartedAt: row.started_at || row.created_at || null,
    styleBibleGeneratedAt: generatedAt,
    styleBible,
    run: styleBibleRunPayload(row),
  };
}

function shouldHealCompletedStyleBibleMirror(proj: any, draft: any, generatedAt: string) {
  if ((proj as any).styleBibleStatus !== 'ready') return true;
  if ((proj as any).styleBibleRunId) return true;
  if ((proj as any).styleBibleStage) return true;
  if ((proj as any).styleBibleProgress !== 100) return true;
  if ((proj as any).styleBibleGeneratedAt !== generatedAt) return true;
  return safeJson((proj as any).styleBible || {}) !== safeJson(draft || {});
}

function styleBibleRunPayload(row: any) {
  return {
    runId: row.run_id,
    status: row.status,
    stage: row.stage,
    attempt: row.attempt,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    nextRetryAt: row.next_retry_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
  };
}

function isRecord(value: any) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeJson(value: any) {
  try { return JSON.stringify(value || {}); } catch { return '{}'; }
}

function progressForStatusStage(stage: string) {
  if (stage === 'core') return 0;
  if (stage === 'characters') return 20;
  if (stage === 'visual_palette') return 40;
  if (stage === 'visual_prompts') return 55;
  if (stage === 'visual_lens') return 70;
  if (stage === 'production') return 85;
  return null;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const requestStyleOptions = mergeStyleOptions({}, body.styleOptions || {});
  const requestStyleTemplateSnapshot = body.styleTemplateSnapshot || body.style_template_snapshot || null;
  const requestWorldTemplateSnapshot = body.worldTemplateSnapshot || body.world_template_snapshot || null;

  const proj = projectId ? getProjectByIdForUser(projectId, user.id) : null;
  if (projectId && !proj) return jsonError('项目不存在', 404);

  const finalScript = projectId
    ? ((proj as any)?.script || '').toString()
    : (body.script || body.scriptText || '').toString();
  if (!finalScript) return jsonError(projectId ? '请先完成剧本' : '当前没有剧本可分析', 400);
  if (projectId && (proj as any)?.scriptApproved !== true) return jsonError('请先确认剧本', 400);

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  let effectiveStyleOptions = mergeStyleOptions((proj as any)?.styleOptions || {}, requestStyleOptions);
  let effectiveStyleTemplateSnapshot = requestStyleTemplateSnapshot
    || (proj as any)?.styleTemplateSnapshot
    || (proj as any)?.styleOptions?.templateStyleBibleSnapshot
    || null;
  let effectiveWorldTemplateSnapshot = requestWorldTemplateSnapshot
    || (proj as any)?.worldTemplateSnapshot
    || null;
  const creatorProfile = body.creatorProfile || (proj as any)?.creatorProfile || {};

  if (projectId && proj) {
    let locked = false;
    let alreadyGenerating = false;
    const lockedProject = patchProjectForUser(projectId, user.id, (current: any) => {
      if (current.styleBibleStatus === 'generating') {
        const started = Date.parse(current.styleBibleStartedAt || '');
        const lockIsFresh = Number.isFinite(started) && Date.now() - started < STYLE_BIBLE_LOCK_TTL_MS;
        if (lockIsFresh) {
          alreadyGenerating = true;
          return null;
        }
      }
      locked = true;
      effectiveStyleOptions = mergeStyleOptions(current.styleOptions || {}, requestStyleOptions);
      effectiveStyleTemplateSnapshot = requestStyleTemplateSnapshot
        || current.styleTemplateSnapshot
        || current.styleOptions?.templateStyleBibleSnapshot
        || null;
      effectiveWorldTemplateSnapshot = requestWorldTemplateSnapshot
        || current.worldTemplateSnapshot
        || null;
      return {
        allowStyleBibleRunOverwrite: true,
        styleOptions: mergeStyleOptions(current.styleOptions || {}, effectiveStyleOptions),
        styleBibleStatus: 'generating',
        styleBibleError: '',
        styleBibleErrorCode: null,
        styleBibleRunId: runId,
        styleBibleStartedAt: startedAt,
        styleBibleStage: 'core',
        styleBibleProgress: 0,
        styleBibleNextRetryAt: null,
        styleBibleHeartbeatAt: null,
      };
    });
    if (alreadyGenerating) {
      return new Response(JSON.stringify({
        detail: '另一处正在生成风格圣经，请稍候',
        code: 'already_generating',
        styleBibleStatus: 'generating',
      }), { status: 409, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    if (!locked || !lockedProject) return jsonError('项目不存在', 404);
  }

  const styleConstraints = sanitizePromptObject(
    buildStyleBibleConstraintsFromTemplate(effectiveStyleTemplateSnapshot),
  ) as StyleConstraints;
  const worldContext = sanitizePromptObject(
    buildWorldContextFromSnapshot(effectiveWorldTemplateSnapshot),
  ) as WorldContext;
  const styleBibleSourceHash = hashNormalizedScript(finalScript);
  const styleBibleGenerationContext = buildStyleBibleGenerationContext({
    aspectRatio: effectiveStyleOptions.aspectRatio,
    worldTemplateSnapshot: effectiveWorldTemplateSnapshot,
    styleTemplateSnapshot: effectiveStyleTemplateSnapshot,
  });
  if (projectId && proj) {
    try {
      createStyleBibleRun({
        ownerId: user.id,
        projectId,
        runId,
        input: {
          script: finalScript,
          styleOptions: effectiveStyleOptions,
          styleTemplateSnapshot: effectiveStyleTemplateSnapshot,
          worldTemplateSnapshot: effectiveWorldTemplateSnapshot,
          creatorProfile,
          styleBibleSourceHash,
          styleBibleGenerationContext,
        },
      });
      ensureStyleBibleRunWorker();
      return jsonOk({
        accepted: true,
        styleBibleStatus: 'generating',
        styleBibleError: '',
        styleBibleErrorCode: null,
        styleBibleRunId: runId,
        styleBibleStartedAt: startedAt,
        styleBibleStage: 'core',
        styleBibleProgress: 0,
        styleBibleNextRetryAt: null,
        styleBibleHeartbeatAt: null,
        styleOptions: effectiveStyleOptions,
        styleTemplateSnapshot: effectiveStyleTemplateSnapshot,
        worldTemplateSnapshot: effectiveWorldTemplateSnapshot,
      });
    } catch (error: any) {
      patchProjectForUser(projectId, user.id, (current: any) => {
        if (current.styleBibleRunId !== runId) return null;
        return {
          allowStyleBibleRunOverwrite: true,
          styleBibleStatus: 'failed',
          styleBibleError: error?.message || String(error),
          styleBibleErrorCode: 'style_bible_task_create_failed',
          styleBibleRunId: null,
          styleBibleStartedAt: null,
          styleBibleStage: null,
          styleBibleProgress: null,
          styleBibleNextRetryAt: null,
          styleBibleHeartbeatAt: null,
        };
      });
      return jsonError('风格圣经任务创建失败：' + (error?.message || String(error)), 500);
    }
  }
  const originalMessages = buildStyleBibleMessages(finalScript, {
    aspectRatio: effectiveStyleOptions.aspectRatio,
    constraints: styleConstraints,
    worldContext,
    creatorProfile,
  });
  let finalMessages = originalMessages;
  let knowledgeContext: KnowledgeContextForStage | null = null;
  if (projectId && proj) {
    try {
      const context = buildKnowledgeContextForStage({
        ownerId: user.id,
        project: {
          ...(proj as any),
          id: projectId,
          styleOptions: effectiveStyleOptions,
          styleTemplateSnapshot: effectiveStyleTemplateSnapshot,
          worldTemplateSnapshot: effectiveWorldTemplateSnapshot,
        },
        stage: 'style_bible',
        stageTarget: {
          aspectRatio: styleBibleGenerationContext.aspectRatio,
          scriptHash: styleBibleSourceHash,
          worldTemplateId: styleBibleGenerationContext.worldTemplateId,
          worldTemplateHash: styleBibleGenerationContext.worldTemplateHash,
          styleTemplateId: styleBibleGenerationContext.styleTemplateId,
          styleTemplateHash: styleBibleGenerationContext.styleTemplateHash,
        },
        runId,
      });
      const injected = maybeInjectKnowledgePromptBlock({ messages: originalMessages, context });
      finalMessages = injected.messages;
      knowledgeContext = injected.context;
    } catch (error) {
      console.warn('[style-bible] knowledge context injection skipped:', error);
    }
  }

  let styleBible: any = null;
  try {
    styleBible = await chatCompleteJsonWithRetry(
      user,
      finalMessages,
      { temperature: 0.4, maxTokens: 5000, modelRole: 'styleBible' },
      (raw) => parseJsonLoose(raw),
      'styleBible',
    );
  } catch (e: any) {
    const styleBibleError = e?.message || String(e);
    if (projectId && proj) {
      patchProjectForUser(projectId, user.id, (current: any) => {
        if (current.styleBibleRunId !== runId) return null;
        return {
          allowStyleBibleRunOverwrite: true,
          styleBibleStatus: 'failed',
          styleBibleError,
          styleBibleRunId: null,
          styleBibleStartedAt: null,
        };
      });
    }
    return jsonError('风格圣经生成失败：' + styleBibleError, 502);
  }

  styleBible = sinicizeColorPalette(styleBible);
  styleBible = sanitizePromptObject(styleBible);
  styleBible = normalizeLLMStyleBibleOutput(styleBible);
  styleBible = mergeStyleBibleWithConstraints(styleBible, styleConstraints);
  styleBible = normalizeGeneratedStyleBible(styleBible, effectiveStyleOptions);
  const styleBibleGeneratedAt = new Date().toISOString();
  let recentMapping: { worldTemplateId: string; styleTemplateId: string; worldTemplateOwnerId?: number } | null = null;

  if (projectId && proj) {
    let lostLock = false;
    patchProjectForUser(projectId, user.id, (current: any) => {
      if (current.styleBibleRunId !== runId) {
        lostLock = true;
        return null;
      }
      if (current.selectedWorldTemplateId && current.selectedStyleTemplateId) {
        recentMapping = {
          worldTemplateId: String(current.selectedWorldTemplateId),
          styleTemplateId: String(current.selectedStyleTemplateId),
          worldTemplateOwnerId: current.worldTemplateSnapshot?.ownerId || current.worldTemplateSnapshot?.owner_id,
        };
      }
      return {
        allowStyleBibleRunOverwrite: true,
        styleBible,
        styleOptions: mergeStyleOptions(current.styleOptions || {}, effectiveStyleOptions),
        styleBibleStatus: 'ready',
        styleBibleError: '',
        styleBibleGeneratedAt,
        styleBibleSource: 'generated',
        styleBibleRunId: null,
        styleBibleStartedAt: null,
        styleBibleSourceHash,
        styleBibleGenerationContext,
        styleBibleStaleReason: null,
        styleBibleStaleSince: null,
        styleBibleManuallyEditedAt: null,
      };
    });
    if (lostLock) return jsonError('风格圣经生成已被更新请求接管，请刷新项目', 409);
    if (recentMapping) {
      const result = setRecentWorldStyleMapping(user.id, recentMapping);
      if ('error' in result) console.warn('[style-bible] recent mapping skipped:', result.error);
    }
    try {
      if (knowledgeContext) recordKnowledgeContextBestEffort({ ownerId: user.id, projectId, context: knowledgeContext, runId });
    } catch (error) {
      console.warn('[style-bible] knowledge context audit skipped:', error);
    }
  }
  return jsonOk({
    styleBible,
    styleBibleStatus: 'ready',
    styleBibleError: '',
    styleBibleGeneratedAt,
    styleBibleSource: 'generated',
    styleBibleSourceHash,
    styleBibleGenerationContext,
    styleOptions: effectiveStyleOptions,
    styleTemplateSnapshot: effectiveStyleTemplateSnapshot,
    worldTemplateSnapshot: effectiveWorldTemplateSnapshot,
    styleBibleRunId: null,
    styleBibleStartedAt: null,
    styleBibleStaleReason: null,
    styleBibleStaleSince: null,
    styleBibleManuallyEditedAt: null,
  });
}

function mergeStyleOptions(base: any, incoming: any) {
  const next = { ...(base || {}) };
  const src = incoming || {};
  for (const key of ['aspectRatio'] as const) {
    if (Object.prototype.hasOwnProperty.call(src, key)) next[key] = src[key];
  }
  if (src.userControls && typeof src.userControls === 'object') {
    // Legacy style controls are no longer a style-page input source.
  }
  delete next.selectedTemplateId;
  delete next.selectedTemplateName;
  delete next.templateStyleBibleSnapshot;
  delete next.userControls;
  if (!next.aspectRatio) next.aspectRatio = '9:16';
  if (!['16:9', '9:16', '1:1'].includes(String(next.aspectRatio))) next.aspectRatio = '9:16';
  return next;
}

function buildStyleBibleGenerationContext(input: {
  aspectRatio: any;
  worldTemplateSnapshot: any;
  styleTemplateSnapshot: any;
}) {
  const worldId = cleanTemplateId(input.worldTemplateSnapshot);
  const styleId = cleanTemplateId(input.styleTemplateSnapshot);
  return {
    aspectRatio: ['16:9', '9:16', '1:1'].includes(String(input.aspectRatio)) ? String(input.aspectRatio) : '9:16',
    worldTemplateId: worldId,
    worldTemplateHash: worldTemplateHashOf(input.worldTemplateSnapshot),
    styleTemplateId: styleId,
    styleTemplateHash: styleTemplateHashOf(input.styleTemplateSnapshot),
  };
}

function cleanTemplateId(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const id = String(snapshot.id || snapshot.templateId || snapshot.template_id || '').trim();
  return id || null;
}

function normalizeGeneratedStyleBible(styleBible: any, styleOptions: any) {
  const sb = styleBible && typeof styleBible === 'object' ? { ...styleBible } : {};
  const aspectRatio = ['16:9', '9:16', '1:1'].includes(String(sb.aspectRatio))
    ? String(sb.aspectRatio)
    : String(styleOptions?.aspectRatio || '9:16');
  sb.aspectRatio = ['16:9', '9:16', '1:1'].includes(aspectRatio) ? aspectRatio : '9:16';
  if (!String(sb.compositionGuidance || '').trim()) {
    sb.compositionGuidance = compositionGuidanceForAspectRatio(sb.aspectRatio);
  }
  return sb;
}

function compositionGuidanceForAspectRatio(aspectRatio: string) {
  if (aspectRatio === '9:16') return '采用纵向主体构图，近景与中景占比更高，减少宽横幅空间铺陈、大横摇和多人横向排布，优先突出人物与关键动作。';
  if (aspectRatio === '1:1') return '采用中心构图和对称关系，保持主体聚焦与稳定视觉重心，减少极宽景别，用前后景层次强化画面张力。';
  return '采用横向叙事构图，允许大全景、横摇、跟拍和空间关系调度，在群像与环境信息之间保持清晰层次。';
}
