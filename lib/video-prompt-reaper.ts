import { getDb } from './db';
import { patchProjectForUser } from './projects-db';
import { maybeAssertStoryboardsAlignedWithShots, storyboardShotIndices } from './frame-workflow-state';
import { markStoryboardVideoOutdated, markVideoTaskOutdated } from './video-prompt-state';
import { logVideoPromptTrace, summarizePromptForTrace } from './video-prompt-observability';

type ReapAction = {
  projectId: string;
  ownerId: number;
  groupIdx: number;
  runId: string;
  action: 'ready' | 'failed';
  reason: string;
  prompt?: string;
  errorMessage?: string;
  referenceManifest?: any[];
  droppedReferences?: any[];
  completedAt?: string;
};

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name] || process.env[`ORIGIN_${name}`];
  const n = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export const VIDEO_PROMPT_REAPER_TIMEOUT_MS = envInt(
  'VIDEO_PROMPT_REAPER_TIMEOUT_MS',
  15 * 60 * 1000,
  5 * 60 * 1000,
  60 * 60 * 1000,
);

export const VIDEO_PROMPT_REAPER_INTERVAL_MS = envInt(
  'VIDEO_PROMPT_REAPER_INTERVAL_MS',
  5 * 60 * 1000,
  60 * 1000,
  60 * 60 * 1000,
);

const VIDEO_PROMPT_BATCH_MISSING_TIMEOUT_MS = envInt(
  'VIDEO_PROMPT_BATCH_MISSING_TIMEOUT_MS',
  60 * 60 * 1000,
  15 * 60 * 1000,
  24 * 60 * 60 * 1000,
);

function parseJson(value: string | null | undefined): any {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function ageMs(iso: unknown) {
  const time = Date.parse(String(iso || ''));
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Date.now() - time;
}

function taskGroupIdx(task: any): number | null {
  const target = parseJson(task?.target_json);
  const raw = target?.groupIdx ?? target?.storyboardIdx ?? target?.idx;
  const groupIdx = Number(raw);
  if (!Number.isFinite(groupIdx) || groupIdx < 0) return null;
  return Math.floor(groupIdx);
}

function promptFromResult(result: any): string {
  const extraPrompt = result?.extra?.videoPrompt;
  const patchPrompt = result?.patch?.type === 'video_prompt' ? result?.patch?.value : '';
  return String(extraPrompt || patchPrompt || '').trim();
}

function taskReferenceManifest(result: any): any[] | undefined {
  if (Array.isArray(result?.extra?.referenceManifest)) return result.extra.referenceManifest;
  if (Array.isArray(result?.extra?.videoReferenceManifest)) return result.extra.videoReferenceManifest;
  if (Array.isArray(result?.patch?.videoReferenceManifest)) return result.patch.videoReferenceManifest;
  return undefined;
}

function taskDroppedReferences(result: any): any[] | undefined {
  if (Array.isArray(result?.extra?.droppedReferences)) return result.extra.droppedReferences;
  if (Array.isArray(result?.extra?.videoReferenceDropped)) return result.extra.videoReferenceDropped;
  if (Array.isArray(result?.patch?.videoReferenceDropped)) return result.patch.videoReferenceDropped;
  return undefined;
}

function isTerminalBatchStatus(status: string) {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'partial';
}

function isActiveTaskStatus(status: string) {
  return status === 'queued' || status === 'running' || status === 'retry_pending' || status === 'upstream_pending';
}

function findBatchAction(db: ReturnType<typeof getDb>, opts: {
  projectId: string;
  ownerId: number;
  groupIdx: number;
  runId: string;
  startedAt: unknown;
}): ReapAction | null {
  const rows = db
    .prepare<{ batchId: string }, any>(
      `SELECT bt.*, b.status AS batch_status, b.batch_type AS batch_type
              , b.updated_at AS batch_updated_at
         FROM batch_tasks bt
         JOIN batches b ON b.id = bt.batch_id
        WHERE bt.batch_id = @batchId
        ORDER BY bt.seq ASC`,
    )
    .all({ batchId: opts.runId });

  if (!rows.length) {
    if (ageMs(opts.startedAt) < VIDEO_PROMPT_BATCH_MISSING_TIMEOUT_MS) return null;
    return {
      projectId: opts.projectId,
      ownerId: opts.ownerId,
      groupIdx: opts.groupIdx,
      runId: opts.runId,
      action: 'failed',
      reason: 'batch_missing_timeout',
      errorMessage: '系统检测到生成任务长时间未完成（超时），请重新生成',
    };
  }

  const videoRows = rows.filter((row) => String(row.batch_type || '') === 'video_prompts');
  if (!videoRows.length) return null;
  const row = videoRows.find((item) => taskGroupIdx(item) === opts.groupIdx);
  if (!row) {
    if (isTerminalBatchStatus(String(videoRows[0]?.batch_status || ''))) {
      return {
        projectId: opts.projectId,
        ownerId: opts.ownerId,
        groupIdx: opts.groupIdx,
        runId: opts.runId,
        action: 'failed',
        reason: 'batch_task_missing_terminal',
        errorMessage: '系统检测到生成任务缺少结果，请重新生成',
      };
    }
    return null;
  }

  const taskStatus = String(row.status || '');
  const batchStatus = String(row.batch_status || '');
  const result = parseJson(row.result_json);
  const prompt = promptFromResult(result);
  if (taskStatus === 'completed') {
    if (prompt) {
      return {
        projectId: opts.projectId,
        ownerId: opts.ownerId,
        groupIdx: opts.groupIdx,
        runId: opts.runId,
        action: 'ready',
        reason: 'recover_completed_batch_prompt',
        prompt,
        referenceManifest: taskReferenceManifest(result),
        droppedReferences: taskDroppedReferences(result),
        completedAt: String(row.updated_at || row.batch_updated_at || ''),
      };
    }
    return {
      projectId: opts.projectId,
      ownerId: opts.ownerId,
      groupIdx: opts.groupIdx,
      runId: opts.runId,
      action: 'failed',
      reason: 'completed_task_missing_prompt',
      errorMessage: '系统检测到生成任务完成但缺少提示词，请重新生成',
    };
  }

  if (taskStatus === 'failed' || taskStatus === 'cancelled' || taskStatus === 'needs_review') {
    return {
      projectId: opts.projectId,
      ownerId: opts.ownerId,
      groupIdx: opts.groupIdx,
      runId: opts.runId,
      action: 'failed',
      reason: `batch_task_${taskStatus}`,
      errorMessage: String(row.error_msg || row.error_message || '系统检测到生成任务未完成，请重新生成').slice(0, 500),
    };
  }

  if (isActiveTaskStatus(taskStatus) || batchStatus === 'running' || batchStatus === 'queued') return null;
  if (isTerminalBatchStatus(batchStatus)) {
    return {
      projectId: opts.projectId,
      ownerId: opts.ownerId,
      groupIdx: opts.groupIdx,
      runId: opts.runId,
      action: 'failed',
      reason: `batch_${batchStatus}_without_prompt`,
      errorMessage: '系统检测到生成任务没有可用结果，请重新生成',
    };
  }
  return null;
}

function collectProjectActions(row: any): ReapAction[] {
  const db = getDb();
  const data = parseJson(row.data_json);
  const storyboards = Array.isArray(data.storyboards) ? data.storyboards : [];
  const actions: ReapAction[] = [];
  for (let groupIdx = 0; groupIdx < storyboards.length; groupIdx += 1) {
    const sb = storyboards[groupIdx] || {};
    if (sb.videoPromptStatus !== 'generating') continue;
    const runId = String(sb.videoPromptRunId || '').trim();
    if (!runId) continue;

    if (runId.startsWith('vp_')) {
      if (ageMs(sb.videoPromptStartedAt) < VIDEO_PROMPT_REAPER_TIMEOUT_MS) continue;
      actions.push({
        projectId: String(row.id),
        ownerId: Number(row.owner_id),
        groupIdx,
        runId,
        action: 'failed',
        reason: 'single_shot_timeout',
        errorMessage: '系统检测到生成任务长时间未完成（超时），请重新生成',
      });
      continue;
    }

    const batchAction = findBatchAction(db, {
      projectId: String(row.id),
      ownerId: Number(row.owner_id),
      groupIdx,
      runId,
      startedAt: sb.videoPromptStartedAt,
    });
    if (batchAction) actions.push(batchAction);
  }
  return actions;
}

function applyProjectActions(projectId: string, ownerId: number, actions: ReapAction[]) {
  if (!actions.length) return { ready: 0, failed: 0, skipped: 0 };
  let ready = 0;
  let failed = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  patchProjectForUser(projectId, ownerId, (fresh) => {
    const storyboards = Array.isArray((fresh as any).storyboards) ? [...(fresh as any).storyboards] : [];
    const videoTasks = Array.isArray((fresh as any).videoTasks) ? [...(fresh as any).videoTasks] : [];
    let changed = false;
    for (const action of actions) {
      const prev = storyboards[action.groupIdx];
      if (!prev || prev.videoPromptStatus !== 'generating' || prev.videoPromptRunId !== action.runId) {
        skipped += 1;
        continue;
      }
      const shotIndices = storyboardShotIndices(fresh as any, action.groupIdx, prev, { mode: 'single-shot-strict' });
      if (action.action === 'ready' && action.prompt) {
        const promptUpdatedAt = action.completedAt || now;
        storyboards[action.groupIdx] = {
          ...markStoryboardVideoOutdated(prev, 'video_prompt_regeneration', now),
          idx: action.groupIdx,
          shotIdx: action.groupIdx + 1,
          shotIndices,
          videoPrompt: action.prompt,
          videoPromptStatus: 'ready',
          videoPromptRunId: action.runId,
          videoPromptUpdatedAt: promptUpdatedAt,
          videoPromptLastError: undefined,
          videoPromptFailedAt: undefined,
          ...(action.referenceManifest ? { videoReferenceManifest: action.referenceManifest } : {}),
          ...(action.droppedReferences ? { videoReferenceDropped: action.droppedReferences } : {}),
        };
        ready += 1;
      } else {
        storyboards[action.groupIdx] = {
          ...markStoryboardVideoOutdated(prev, 'video_prompt_failed', now),
          idx: action.groupIdx,
          shotIdx: action.groupIdx + 1,
          shotIndices,
          videoPromptStatus: 'failed',
          videoPromptRunId: action.runId,
          videoPromptFailedAt: now,
          videoPromptLastError: String(action.errorMessage || '系统检测到生成任务长时间未完成（超时），请重新生成').slice(0, 500),
        };
        failed += 1;
      }
      if (videoTasks.length > action.groupIdx && videoTasks[action.groupIdx]) {
        videoTasks[action.groupIdx] = markVideoTaskOutdated(
          videoTasks[action.groupIdx],
          action.action === 'ready' ? 'video_prompt_regeneration' : 'video_prompt_failed',
          now,
        );
      }
      changed = true;
      logVideoPromptTrace('video_prompt_reaper_swept', {
        projectId,
        groupIdx: action.groupIdx,
        runId: action.runId,
        action: action.action,
        reason: action.reason,
        completedAt: action.completedAt || null,
        promptSummary: action.prompt ? summarizePromptForTrace(action.prompt) : '',
      }, action.action === 'ready' ? 'info' : 'warn');
    }
    if (!changed) return {};
    maybeAssertStoryboardsAlignedWithShots({ ...(fresh as any), storyboards, videoTasks }, 'video-prompt-reaper');
    return { storyboards, videoTasks };
  });
  return { ready, failed, skipped };
}

export function reapOrphanVideoPrompts() {
  const db = getDb();
  const rows = db
    .prepare<[], any>(
      `SELECT id, owner_id, data_json
         FROM projects
        WHERE data_json LIKE '%"videoPromptStatus":"generating"%'
        ORDER BY updated_at DESC`,
    )
    .all();
  let ready = 0;
  let failed = 0;
  let skipped = 0;
  let projectCount = 0;
  for (const row of rows) {
    const actions = collectProjectActions(row);
    if (!actions.length) continue;
    try {
      const result = applyProjectActions(String(row.id), Number(row.owner_id), actions);
      ready += result.ready;
      failed += result.failed;
      skipped += result.skipped;
      if (result.ready || result.failed) projectCount += 1;
    } catch (error: any) {
      console.warn('[video-prompt-reaper] patch failed for project', row.id, error);
      logVideoPromptTrace('video_prompt_reaper_sweep_failed', {
        projectId: String(row.id),
        error: (error?.message || String(error)).slice(0, 500),
      }, 'error');
    }
  }
  if (ready || failed || skipped) {
    console.info(`[video-prompt-reaper] ready=${ready} failed=${failed} skipped=${skipped} projects=${projectCount}`);
  }
  return { ready, failed, skipped, projects: projectCount };
}

export function startVideoPromptReaperLoop() {
  const key = Symbol.for('__video_prompt_reaper_started__');
  if ((globalThis as any)[key]) return;
  (globalThis as any)[key] = true;
  setTimeout(() => {
    try { reapOrphanVideoPrompts(); } catch (e) { console.warn('[video-prompt-reaper] initial sweep failed', e); }
  }, 0);
  const timer = setInterval(() => {
    try { reapOrphanVideoPrompts(); } catch (e) { console.warn('[video-prompt-reaper] periodic sweep failed', e); }
  }, VIDEO_PROMPT_REAPER_INTERVAL_MS);
  if (timer && typeof (timer as any).unref === 'function') (timer as any).unref();
}
