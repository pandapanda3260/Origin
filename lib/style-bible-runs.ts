import { randomUUID } from 'node:crypto';
import { getDb, type ProjectRow, type UserRow } from './db';
import { getProjectByIdForUser, patchProjectForUser } from './projects-db';
import { chatCompleteJsonWithRetry, parseJsonLoose } from './llm';
import {
  buildStyleBibleStageMessages,
  type StyleBibleStageName,
} from './prompts';
import {
  finalizeStyleBibleDraft,
  mergeStyleBibleStageDraft,
  validateFinalStyleBible,
  validateStyleBibleStage,
} from './style-bible-contract';
import { sinicizeColorPalette } from './style-bible';
import { sanitizePromptObject } from './content-sanitize';
import {
  buildStyleBibleConstraintsFromTemplate,
  normalizeLLMStyleBibleOutput,
  type StyleConstraints,
} from './style-template-constraints';
import {
  buildWorldContextFromSnapshot,
  projectWorldContextForStyleBibleStage,
  type WorldContext,
} from './world-template-context';
import { buildKnowledgeContextForStage } from './knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from './knowledge/context-db';
import { maybeInjectKnowledgePromptBlock } from './knowledge/inject-messages';

export type StyleBibleRunStatus =
  | 'queued'
  | 'running'
  | 'retry_pending'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StyleBibleRunRow = {
  id: string;
  owner_id: number;
  project_id: string;
  run_id: string;
  status: StyleBibleRunStatus;
  stage: StyleBibleStageName;
  attempt: number;
  max_attempts: number;
  max_tokens: number | null;
  draft_json: string;
  input_json: string;
  meta_json: string;
  error_code: string | null;
  error_message: string | null;
  heartbeat_at: string | null;
  next_retry_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StyleBibleRunInput = {
  script: string;
  styleOptions?: any;
  styleTemplateSnapshot?: any;
  worldTemplateSnapshot?: any;
  creatorProfile?: any;
  styleBibleSourceHash?: string | null;
  styleBibleGenerationContext?: any;
};

export const STYLE_BIBLE_RUN_STAGES: StyleBibleStageName[] = [
  'core',
  'characters',
  'visual_palette',
  'visual_prompts',
  'visual_lens',
  'production',
];
export const STYLE_BIBLE_MAX_INFLIGHT_STAGES = 3;
export const STYLE_BIBLE_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const STYLE_BIBLE_HEARTBEAT_STALE_MS = 2 * 60 * 1000;

const ERROR_HISTORY_LIMIT = 20;
const WORKER_TICK_MS = 5000;
let __sbrSchemaEnsured = false;
let __testJsonCaller: typeof chatCompleteJsonWithRetry | null = null;
const STYLE_BIBLE_STAGE_TOKEN_POLICY: Record<StyleBibleStageName, { base: number; retry: number }> = {
  core: { base: 12_000, retry: 22_000 },
  characters: { base: 12_000, retry: 22_000 },
  visual: { base: 12_000, retry: 22_000 },
  visual_palette: { base: 12_000, retry: 22_000 },
  visual_prompts: { base: 8_000, retry: 14_000 },
  visual_lens: { base: 12_000, retry: 22_000 },
  production: { base: 10_000, retry: 14_000 },
};

/** Test-only seam, do not call from production code. */
export function setStyleBibleRunJsonCallerForTests(fn: typeof chatCompleteJsonWithRetry | null) {
  __testJsonCaller = fn;
}

export function createStyleBibleRun(args: {
  ownerId: number;
  projectId: string;
  runId?: string;
  input: StyleBibleRunInput;
}) {
  ensureStyleBibleRunsSchema();
  const db = getDb();
  const id = randomUUID();
  const runId = args.runId || randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO style_bible_runs
      (id, owner_id, project_id, run_id, status, stage, attempt, max_attempts,
       draft_json, input_json, meta_json, started_at, created_at, updated_at)
     VALUES
      (@id, @ownerId, @projectId, @runId, 'queued', 'core', 0, 3,
       '{}', @inputJson, @metaJson, @now, @now, @now)`,
  ).run({
    id,
    ownerId: args.ownerId,
    projectId: args.projectId,
    runId,
    inputJson: safeJson(args.input || {}),
    metaJson: safeJson({ errorHistory: [] }),
    now,
  });
  const row = getStyleBibleRunByRunId(runId);
  if (!row) throw new Error('style_bible_run_insert_failed');
  return row;
}

export function getStyleBibleRunByRunId(runId: string): StyleBibleRunRow | null {
  ensureStyleBibleRunsSchema();
  const row = getDb()
    .prepare<{ runId: string }, StyleBibleRunRow>('SELECT * FROM style_bible_runs WHERE run_id = @runId LIMIT 1')
    .get({ runId });
  return row || null;
}

export function getLatestStyleBibleRunForProject(ownerId: number, projectId: string): StyleBibleRunRow | null {
  ensureStyleBibleRunsSchema();
  const row = getDb()
    .prepare<{ ownerId: number; projectId: string }, StyleBibleRunRow>(
      `SELECT * FROM style_bible_runs
       WHERE owner_id = @ownerId AND project_id = @projectId
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get({ ownerId, projectId });
  return row || null;
}

export function parseStyleBibleRunInput(row: StyleBibleRunRow): StyleBibleRunInput {
  return parseJsonObject(row.input_json);
}

export function parseStyleBibleRunDraft(row: StyleBibleRunRow): any {
  return parseJsonObject(row.draft_json);
}

export function parseStyleBibleRunMeta(row: StyleBibleRunRow): any {
  return parseJsonObject(row.meta_json);
}

export function updateStyleBibleRun(
  runId: string,
  patch: Partial<{
    status: StyleBibleRunStatus;
    stage: StyleBibleStageName;
    attempt: number;
    maxAttempts: number;
    maxTokens: number | null;
    draft: any;
    meta: any;
    errorCode: string | null;
    errorMessage: string | null;
    heartbeatAt: string | null;
    nextRetryAt: string | null;
    completedAt: string | null;
  }>,
) {
  ensureStyleBibleRunsSchema();
  const sets: string[] = ['updated_at = @updatedAt'];
  const params: Record<string, any> = { runId, updatedAt: new Date().toISOString() };
  if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status; }
  if (patch.stage !== undefined) { sets.push('stage = @stage'); params.stage = patch.stage; }
  if (patch.attempt !== undefined) { sets.push('attempt = @attempt'); params.attempt = patch.attempt; }
  if (patch.maxAttempts !== undefined) { sets.push('max_attempts = @maxAttempts'); params.maxAttempts = patch.maxAttempts; }
  if (patch.maxTokens !== undefined) { sets.push('max_tokens = @maxTokens'); params.maxTokens = patch.maxTokens; }
  if (patch.draft !== undefined) { sets.push('draft_json = @draftJson'); params.draftJson = safeJson(patch.draft || {}); }
  if (patch.meta !== undefined) { sets.push('meta_json = @metaJson'); params.metaJson = safeJson(patch.meta || {}); }
  if (patch.errorCode !== undefined) { sets.push('error_code = @errorCode'); params.errorCode = patch.errorCode; }
  if (patch.errorMessage !== undefined) { sets.push('error_message = @errorMessage'); params.errorMessage = patch.errorMessage; }
  if (patch.heartbeatAt !== undefined) { sets.push('heartbeat_at = @heartbeatAt'); params.heartbeatAt = patch.heartbeatAt; }
  if (patch.nextRetryAt !== undefined) { sets.push('next_retry_at = @nextRetryAt'); params.nextRetryAt = patch.nextRetryAt; }
  if (patch.completedAt !== undefined) { sets.push('completed_at = @completedAt'); params.completedAt = patch.completedAt; }
  getDb().prepare(`UPDATE style_bible_runs SET ${sets.join(', ')} WHERE run_id = @runId`).run(params);
  return getStyleBibleRunByRunId(runId);
}

export function appendStyleBibleRunError(
  row: StyleBibleRunRow,
  error: { code: string; message?: string; stage?: string; attempt?: number; at?: string; meta?: any },
) {
  const meta = parseStyleBibleRunMeta(row);
  const history = Array.isArray(meta.errorHistory) ? meta.errorHistory.slice() : [];
  history.push({
    code: error.code,
    message: String(error.message || '').slice(0, 1000),
    stage: error.stage || row.stage,
    attempt: error.attempt ?? row.attempt,
    at: error.at || new Date().toISOString(),
    ...(error.meta ? { meta: error.meta } : {}),
  });
  meta.errorHistory = history.slice(-ERROR_HISTORY_LIMIT);
  return meta;
}

export function claimDueStyleBibleRuns(limit = STYLE_BIBLE_MAX_INFLIGHT_STAGES): StyleBibleRunRow[] {
  ensureStyleBibleRunsSchema();
  cancelObsoleteStyleBibleRuns();
  const db = getDb();
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    const rows = db
      .prepare<{ now: string; limit: number }, StyleBibleRunRow>(
        `SELECT * FROM style_bible_runs
         WHERE status IN ('queued', 'retry_pending')
           AND (next_retry_at IS NULL OR next_retry_at <= @now)
         ORDER BY created_at ASC
         LIMIT @limit`,
      )
      .all({ now, limit: Math.max(0, limit) });
    for (const row of rows) {
      db.prepare(
        `UPDATE style_bible_runs
         SET status = 'running',
             heartbeat_at = @now,
             next_retry_at = NULL,
             attempt = attempt + 1,
             updated_at = @now
         WHERE run_id = @runId
           AND status IN ('queued', 'retry_pending')`,
      ).run({ runId: row.run_id, now });
    }
    return rows.map((row) => getStyleBibleRunByRunId(row.run_id)).filter(Boolean) as StyleBibleRunRow[];
  });
  return txn.immediate();
}

export function reconcileStaleStyleBibleRuns() {
  ensureStyleBibleRunsSchema();
  cancelObsoleteStyleBibleRuns();
  const db = getDb();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - STYLE_BIBLE_HEARTBEAT_STALE_MS).toISOString();
  const rows = db
    .prepare<{ cutoff: string }, StyleBibleRunRow>(
      `SELECT * FROM style_bible_runs
       WHERE status = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < @cutoff)`,
    )
    .all({ cutoff });
  for (const row of rows) {
    const meta = appendStyleBibleRunError(row, {
      code: 'worker_recovered_after_restart',
      message: 'running stage heartbeat expired and was moved back to retry_pending',
      at: now,
    });
    const updated = updateStyleBibleRun(row.run_id, {
      status: 'retry_pending',
      meta,
      errorCode: 'worker_recovered_after_restart',
      errorMessage: '后台任务恢复：上一进程心跳过期，已重新排队',
      heartbeatAt: null,
      nextRetryAt: now,
    });
    if (updated) syncStyleBibleProjectMirror(updated);
  }
  return rows.length;
}

export function syncStyleBibleProjectMirror(row: StyleBibleRunRow) {
  const patch = styleBibleProjectMirrorPatch(row);
  patchProjectForUser(row.project_id, row.owner_id, (current: any) => {
    if (current.styleBibleRunId && current.styleBibleRunId !== row.run_id) return null;
    return { ...patch, allowStyleBibleRunOverwrite: true };
  });
}

export function styleBibleProjectMirrorPatch(row: StyleBibleRunRow) {
  if (row.status === 'completed') {
    return {
      styleBibleStatus: 'ready',
      styleBibleError: '',
      styleBibleErrorCode: null,
      styleBibleRunId: null,
      styleBibleStage: null,
      styleBibleProgress: 100,
      styleBibleNextRetryAt: null,
      styleBibleHeartbeatAt: null,
      styleBibleStaleReason: null,
      styleBibleStaleSince: null,
    };
  }
  if (row.status === 'failed' || row.status === 'cancelled') {
    return {
      styleBibleStatus: 'failed',
      styleBibleError: row.error_message || '风格圣经生成失败',
      styleBibleErrorCode: row.error_code || 'unknown_error',
      styleBibleRunId: null,
      styleBibleStage: row.stage,
      styleBibleProgress: progressForStyleBibleStage(row.stage),
      styleBibleNextRetryAt: null,
      styleBibleHeartbeatAt: row.heartbeat_at,
    };
  }
  return {
    styleBibleStatus: 'generating',
    styleBibleError: row.error_message || '',
    styleBibleErrorCode: row.error_code || null,
    styleBibleRunId: row.run_id,
    styleBibleStage: row.stage,
    styleBibleProgress: progressForStyleBibleStage(row.stage),
    styleBibleNextRetryAt: row.next_retry_at,
    styleBibleHeartbeatAt: row.heartbeat_at,
    styleBibleStartedAt: row.started_at || row.created_at,
  };
}

export function progressForStyleBibleStage(stage: StyleBibleStageName | string) {
  const index = STYLE_BIBLE_RUN_STAGES.indexOf(stage as StyleBibleStageName);
  if (index < 0) return 0;
  return Math.round((index / STYLE_BIBLE_RUN_STAGES.length) * 100);
}

export function getUserForStyleBibleRun(row: StyleBibleRunRow): UserRow | null {
  const user = getDb()
    .prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id LIMIT 1')
    .get({ id: row.owner_id });
  return user || null;
}

export function ensureStyleBibleRunWorker() {
  const key = '__origin_style_bible_worker_started__';
  if ((globalThis as any)[key]) return;
  (globalThis as any)[key] = true;
  try { reconcileStaleStyleBibleRuns(); } catch (error) { console.error('[style-bible-worker] reconcile:', error); }
  setInterval(() => {
    tickStyleBibleRunWorker().catch((error) => console.error('[style-bible-worker] tick:', error));
  }, WORKER_TICK_MS).unref?.();
  void tickStyleBibleRunWorker().catch((error) => console.error('[style-bible-worker] initial tick:', error));
}

const inflightStyleBibleRuns = new Set<string>();

export async function tickStyleBibleRunWorker() {
  const available = STYLE_BIBLE_MAX_INFLIGHT_STAGES - inflightStyleBibleRuns.size;
  if (available <= 0) return;
  const rows = claimDueStyleBibleRuns(available)
    .filter((row) => !inflightStyleBibleRuns.has(row.run_id));
  for (const row of rows) {
    inflightStyleBibleRuns.add(row.run_id);
    void processStyleBibleRun(row)
      .catch((error) => console.error('[style-bible-worker] process:', row.run_id, error))
      .finally(() => inflightStyleBibleRuns.delete(row.run_id));
  }
}

export async function processStyleBibleRun(claimedRow: StyleBibleRunRow) {
  let row = getStyleBibleRunByRunId(claimedRow.run_id);
  if (!row || row.status !== 'running') return;
  if (!isActiveStyleBibleStage(row.stage)) {
    failStyleBibleRun(row, 'stage_obsolete', 'stage 不在新 STYLE_BIBLE_RUN_STAGES 中，已停止', 'cancelled');
    return;
  }
  if (isRunTimedOut(row)) {
    failStyleBibleRun(row, 'run_timeout', '风格圣经生成超过 30 分钟，已停止本次任务', 'cancelled');
    return;
  }
  if (!isStyleBibleRunCurrent(row)) {
    updateStyleBibleRun(row.run_id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      heartbeatAt: null,
      nextRetryAt: null,
      errorCode: 'superseded',
      errorMessage: '风格圣经生成已被新的请求接管',
    });
    return;
  }

  updateRunAndMirror(row, {
    heartbeatAt: new Date().toISOString(),
    errorCode: null,
    errorMessage: null,
  });
  row = getStyleBibleRunByRunId(row.run_id) || row;

  const input = parseStyleBibleRunInput(row);
  const user = getUserForStyleBibleRun(row);
  if (!user) {
    failStyleBibleRun(row, 'unknown_error', '用户不存在或已不可用');
    return;
  }

  const constraints = sanitizePromptObject(
    buildStyleBibleConstraintsFromTemplate(input.styleTemplateSnapshot),
  ) as StyleConstraints;
  const worldContext = sanitizePromptObject(
    projectWorldContextForStyleBibleStage(
      buildWorldContextFromSnapshot(input.worldTemplateSnapshot),
      row.stage,
      String(input.script || ''),
    ),
  ) as WorldContext;
  const draft = parseStyleBibleRunDraft(row);
  const maxTokens = resolveStageMaxTokens(row);
  let messages = buildStyleBibleStageMessages(String(input.script || ''), {
    stage: row.stage,
    aspectRatio: input.styleOptions?.aspectRatio,
    constraints,
    worldContext,
    creatorProfile: input.creatorProfile || {},
    draft,
  });
  let knowledgeContext: any = null;
  try {
    const project = getProjectByIdForUser(row.project_id, row.owner_id);
    if (project) {
      const context = buildKnowledgeContextForStage({
        ownerId: row.owner_id,
        project: {
          ...(project as any),
          id: row.project_id,
          styleOptions: input.styleOptions,
          styleTemplateSnapshot: input.styleTemplateSnapshot,
          worldTemplateSnapshot: input.worldTemplateSnapshot,
        },
        stage: 'style_bible',
        stageTarget: {
          stage: row.stage,
          aspectRatio: input.styleOptions?.aspectRatio || null,
          scriptHash: input.styleBibleSourceHash || null,
          styleTemplateId: input.styleBibleGenerationContext?.styleTemplateId || null,
          styleTemplateHash: input.styleBibleGenerationContext?.styleTemplateHash || null,
          worldTemplateId: input.styleBibleGenerationContext?.worldTemplateId || null,
          worldTemplateHash: input.styleBibleGenerationContext?.worldTemplateHash || null,
        },
        runId: row.run_id,
      });
      const injected = maybeInjectKnowledgePromptBlock({ messages, context });
      messages = injected.messages;
      knowledgeContext = injected.context;
    }
  } catch (error) {
    console.warn('[style-bible-worker] knowledge context injection skipped:', error);
  }

  let output: any;
  try {
    const jsonCaller = __testJsonCaller || chatCompleteJsonWithRetry;
    output = await jsonCaller(
      user,
      messages,
      {
        temperature: 0.4,
        maxTokens,
        modelRole: 'styleBible',
        maxAttempts: 1,
      },
      (raw) => parseJsonLoose(raw),
      `styleBible.${row.stage}`,
    );
  } catch (error: any) {
    handleStyleBibleStageError(row, classifyStyleBibleRunError(error), error?.message || String(error), error);
    return;
  }

  if (!isStyleBibleRunCurrent(row)) {
    updateStyleBibleRun(row.run_id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      heartbeatAt: null,
      nextRetryAt: null,
      errorCode: 'superseded',
      errorMessage: '风格圣经生成已被新的请求接管',
    });
    return;
  }

  output = sinicizeColorPalette(output);
  output = sanitizePromptObject(output);
  output = normalizeLLMStyleBibleOutput(output);
  row = recordStyleBibleStageOutput(row, output);
  const stageValidation = validateStyleBibleStage(row.stage, output);
  if (!stageValidation.ok) {
    handleStyleBibleStageError(
      row,
      'style_bible_incomplete',
      `生成结果不完整：missing=${stageValidation.missing.join(',') || '-'} invalid=${stageValidation.invalid.join(',') || '-'}`,
      { stageValidation },
    );
    return;
  }

  const nextDraft = mergeStyleBibleStageDraft(draft, output, {
    stage: row.stage,
    aspectRatio: input.styleOptions?.aspectRatio,
  });
  try {
    if (knowledgeContext) {
      recordKnowledgeContextBestEffort({
        ownerId: row.owner_id,
        projectId: row.project_id,
        context: knowledgeContext,
        runId: row.run_id,
      });
    }
  } catch (error) {
    console.warn('[style-bible-worker] knowledge context audit skipped:', error);
  }

  const nextStage = nextStyleBibleStage(row.stage);
  if (nextStage) {
    advanceStyleBibleRun(row, nextStage, nextDraft);
    return;
  }

  const finalStyleBible = sanitizePromptObject(finalizeStyleBibleDraft(nextDraft, constraints, {
    aspectRatio: input.styleOptions?.aspectRatio,
  }));
  const finalValidation = validateFinalStyleBible(finalStyleBible);
  if (!finalValidation.ok) {
    handleStyleBibleStageError(
      row,
      'style_bible_incomplete',
      `最终结果不完整：missing=${finalValidation.missing.join(',') || '-'} invalid=${finalValidation.invalid.join(',') || '-'}`,
      { finalValidation },
    );
    return;
  }
  completeStyleBibleRun(row, finalStyleBible, input);
}

function advanceStyleBibleRun(row: StyleBibleRunRow, nextStage: StyleBibleStageName, draft: any) {
  updateRunAndMirror(row, {
    status: 'queued',
    stage: nextStage,
    attempt: 0,
    maxTokens: null,
    draft,
    errorCode: null,
    errorMessage: null,
    heartbeatAt: null,
    nextRetryAt: null,
  });
}

function recordStyleBibleStageOutput(row: StyleBibleRunRow, output: any) {
  const meta = parseStyleBibleRunMeta(row);
  const stageOutputs = isRecord(meta.stageOutputs) ? { ...meta.stageOutputs } : {};
  stageOutputs[row.stage] = output;
  meta.stageOutputs = stageOutputs;
  return updateStyleBibleRun(row.run_id, { meta }) || row;
}

function handleStyleBibleStageError(row: StyleBibleRunRow, code: string, message: string, rawError?: any) {
  const meta = appendStyleBibleRunError(row, {
    code,
    message,
    stage: row.stage,
    attempt: row.attempt,
    meta: errorMeta(rawError),
  });
  const history = Array.isArray(meta.errorHistory) ? meta.errorHistory : [];
  const stageHistory = history.filter((item: any) => item?.stage === row.stage);
  const sawGatewayTimeout = stageHistory.some((item: any) => item?.code === 'gateway_timeout_60s');
  const policy = STYLE_BIBLE_STAGE_TOKEN_POLICY[row.stage];
  const currentTokens = row.max_tokens || policy.base;

  if (code === 'output_incomplete') {
    if (!sawGatewayTimeout && currentTokens < policy.retry) {
      retryStyleBibleRun(row, meta, code, message, {
        maxTokens: policy.retry,
        nextRetryAt: new Date().toISOString(),
      });
      return;
    }
    failStyleBibleRun(row, 'style_bible_incomplete', message, 'failed', meta);
    return;
  }

  if (row.attempt < row.max_attempts && isRetryableStyleBibleError(code)) {
    retryStyleBibleRun(row, meta, code, message, {
      nextRetryAt: nextRetryAtForAttempt(row.attempt, rawError),
    });
    return;
  }
  failStyleBibleRun(row, code, message, 'failed', meta);
}

function retryStyleBibleRun(
  row: StyleBibleRunRow,
  meta: any,
  code: string,
  message: string,
  opts: { nextRetryAt: string; maxTokens?: number },
) {
  updateRunAndMirror(row, {
    status: 'retry_pending',
    meta,
    errorCode: code,
    errorMessage: friendlyStyleBibleErrorMessage(code, message),
    heartbeatAt: null,
    nextRetryAt: opts.nextRetryAt,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
  });
}

function failStyleBibleRun(
  row: StyleBibleRunRow,
  code: string,
  message: string,
  status: 'failed' | 'cancelled' = 'failed',
  meta?: any,
) {
  updateRunAndMirror(row, {
    status,
    draft: {},
    meta: meta || appendStyleBibleRunError(row, { code, message }),
    errorCode: code,
    errorMessage: friendlyStyleBibleErrorMessage(code, message),
    heartbeatAt: null,
    nextRetryAt: null,
    completedAt: new Date().toISOString(),
  });
}

function completeStyleBibleRun(row: StyleBibleRunRow, styleBible: any, input: StyleBibleRunInput) {
  const db = getDb();
  const now = new Date().toISOString();
  let recentMapping: { worldTemplateId: string; styleTemplateId: string; worldTemplateOwnerId?: number } | null = null;
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE style_bible_runs
       SET status = 'completed',
           draft_json = @draftJson,
           error_code = NULL,
           error_message = NULL,
           heartbeat_at = NULL,
           next_retry_at = NULL,
           completed_at = @now,
           updated_at = @now
       WHERE run_id = @runId`,
    ).run({ runId: row.run_id, draftJson: safeJson(styleBible), now });

    const project = db.prepare<{ id: string; ownerId: number }, ProjectRow>(
      'SELECT * FROM projects WHERE id = @id AND owner_id = @ownerId LIMIT 1',
    ).get({ id: row.project_id, ownerId: row.owner_id });
    if (!project) return false;
    const data = parseJsonObject(project.data_json);
    if (data.styleBibleRunId !== row.run_id) return false;
    if (data.selectedWorldTemplateId && data.selectedStyleTemplateId) {
      recentMapping = {
        worldTemplateId: String(data.selectedWorldTemplateId),
        styleTemplateId: String(data.selectedStyleTemplateId),
        worldTemplateOwnerId: data.worldTemplateSnapshot?.ownerId || data.worldTemplateSnapshot?.owner_id,
      };
    }
    const nextData = {
      ...data,
      styleBible,
      styleOptions: { ...(data.styleOptions || {}), ...(input.styleOptions || {}) },
      styleBibleStatus: 'ready',
      styleBibleError: '',
      styleBibleErrorCode: null,
      styleBibleGeneratedAt: now,
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
    };
    db.prepare(
      `UPDATE projects
       SET data_json = @dataJson,
           updated_at = @now
       WHERE id = @id AND owner_id = @ownerId`,
    ).run({
      id: row.project_id,
      ownerId: row.owner_id,
      dataJson: safeJson(nextData),
      now,
    });
    return true;
  });
  const applied = txn.immediate();
  if (!applied) {
    updateStyleBibleRun(row.run_id, {
      status: 'cancelled',
      completedAt: now,
      heartbeatAt: null,
      errorCode: 'superseded',
      errorMessage: '风格圣经生成已被新的请求接管',
    });
  }
  if (applied && recentMapping) {
    try {
      // Import lazily to keep the worker state module focused on the run lifecycle.
      void import('./style-templates-db').then(({ setRecentWorldStyleMapping }) => {
        const result = setRecentWorldStyleMapping(row.owner_id, recentMapping!);
        if ('error' in result) console.warn('[style-bible-worker] recent mapping skipped:', result.error);
      });
    } catch (error) {
      console.warn('[style-bible-worker] recent mapping skipped:', error);
    }
  }
}

function updateRunAndMirror(row: StyleBibleRunRow, patch: Parameters<typeof updateStyleBibleRun>[1]) {
  const db = getDb();
  const txn = db.transaction(() => {
    const updated = updateStyleBibleRun(row.run_id, patch);
    if (updated) patchProjectDataRaw(db, updated, styleBibleProjectMirrorPatch(updated));
    return updated;
  });
  return txn.immediate();
}

function patchProjectDataRaw(db: ReturnType<typeof getDb>, row: StyleBibleRunRow, patch: any) {
  const project = db.prepare<{ id: string; ownerId: number }, ProjectRow>(
    'SELECT * FROM projects WHERE id = @id AND owner_id = @ownerId LIMIT 1',
  ).get({ id: row.project_id, ownerId: row.owner_id });
  if (!project) return false;
  const data = parseJsonObject(project.data_json);
  if (data.styleBibleRunId && data.styleBibleRunId !== row.run_id) return false;
  const nextData = { ...data, ...(patch || {}) };
  db.prepare(
    `UPDATE projects
     SET data_json = @dataJson,
         updated_at = @now
     WHERE id = @id AND owner_id = @ownerId`,
  ).run({
    id: row.project_id,
    ownerId: row.owner_id,
    dataJson: safeJson(nextData),
    now: new Date().toISOString(),
  });
  return true;
}

function isStyleBibleRunCurrent(row: StyleBibleRunRow) {
  const project = getProjectByIdForUser(row.project_id, row.owner_id);
  return !!project && (project as any).styleBibleRunId === row.run_id;
}

function isRunTimedOut(row: StyleBibleRunRow) {
  const started = Date.parse(row.started_at || row.created_at || '');
  return Number.isFinite(started) && Date.now() - started > STYLE_BIBLE_RUN_TIMEOUT_MS;
}

function resolveStageMaxTokens(row: StyleBibleRunRow) {
  const policy = STYLE_BIBLE_STAGE_TOKEN_POLICY[row.stage];
  return row.max_tokens || policy.base;
}

function nextStyleBibleStage(stage: StyleBibleStageName): StyleBibleStageName | null {
  const index = STYLE_BIBLE_RUN_STAGES.indexOf(stage);
  if (index < 0 || index >= STYLE_BIBLE_RUN_STAGES.length - 1) return null;
  return STYLE_BIBLE_RUN_STAGES[index + 1];
}

function isActiveStyleBibleStage(stage: string): stage is StyleBibleStageName {
  return STYLE_BIBLE_RUN_STAGES.includes(stage as StyleBibleStageName);
}

export function cancelObsoleteStyleBibleRuns() {
  ensureStyleBibleRunsSchema();
  const db = getDb();
  const now = new Date().toISOString();
  const activeStages = new Set(STYLE_BIBLE_RUN_STAGES);
  const rows = db
    .prepare<[], StyleBibleRunRow>(
      `SELECT * FROM style_bible_runs
       WHERE status IN ('queued', 'retry_pending')
       ORDER BY created_at ASC`,
    )
    .all();
  const obsolete = rows.filter((row) => !activeStages.has(row.stage));
  if (!obsolete.length) return 0;
  const txn = db.transaction(() => {
    for (const row of obsolete) {
      const meta = appendStyleBibleRunError(row, {
        code: 'stage_obsolete',
        message: 'stage 不在新 STYLE_BIBLE_RUN_STAGES 中，已停止',
        stage: row.stage,
        at: now,
      });
      db.prepare(
        `UPDATE style_bible_runs
         SET status = 'cancelled',
             error_code = 'stage_obsolete',
             error_message = 'stage 不在新 STYLE_BIBLE_RUN_STAGES 中，已停止',
             meta_json = @metaJson,
             heartbeat_at = NULL,
             next_retry_at = NULL,
             completed_at = @now,
             updated_at = @now
         WHERE run_id = @runId
           AND status IN ('queued', 'retry_pending')`,
      ).run({ runId: row.run_id, metaJson: safeJson(meta), now });
    }
  });
  txn.immediate();
  return obsolete.length;
}

export function ensureStyleBibleRunsSchema() {
  if (__sbrSchemaEnsured) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS style_bible_runs (
      id             TEXT PRIMARY KEY,
      owner_id       INTEGER NOT NULL,
      project_id     TEXT NOT NULL,
      run_id         TEXT UNIQUE NOT NULL,
      status         TEXT NOT NULL DEFAULT 'queued',
      stage          TEXT NOT NULL DEFAULT 'core',
      attempt        INTEGER NOT NULL DEFAULT 0,
      max_attempts   INTEGER NOT NULL DEFAULT 3,
      max_tokens     INTEGER,
      draft_json     TEXT NOT NULL DEFAULT '{}',
      input_json     TEXT NOT NULL DEFAULT '{}',
      meta_json      TEXT NOT NULL DEFAULT '{}',
      error_code     TEXT,
      error_message  TEXT,
      heartbeat_at   TEXT,
      next_retry_at  TEXT,
      started_at     TEXT,
      completed_at   TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_style_bible_runs_project
      ON style_bible_runs(owner_id, project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_style_bible_runs_status_due
      ON style_bible_runs(status, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_style_bible_runs_run_id
      ON style_bible_runs(run_id);
  `);
  __sbrSchemaEnsured = true;
}

function isRetryableStyleBibleError(code: string) {
  return [
    'gateway_timeout_60s',
    'provider_rate_limited',
    'json_parse_error',
    'style_bible_incomplete',
    'upstream_error',
    'unknown_error',
  ].includes(code);
}

function classifyStyleBibleRunError(error: any): string {
  const message = String(error?.message || error || '');
  const lower = message.toLowerCase();
  if (
    String(error?.llmStatus || '').toLowerCase() === 'incomplete'
    || lower.includes('output_incomplete')
    || lower.includes('max_output_tokens')
    || lower.includes('reason=max_tokens')
    || lower.includes('stop_reason=max_tokens')
  ) return 'output_incomplete';
  const status = Number(message.match(/^LLM\s+(\d{3})/i)?.[1] || error?.status || error?.statusCode || 0);
  if (status === 504) return 'gateway_timeout_60s';
  if (status === 429) return 'provider_rate_limited';
  if (status >= 500) return 'upstream_error';
  if (error instanceof SyntaxError || lower.includes('json') || lower.includes('parse')) return 'json_parse_error';
  return 'unknown_error';
}

function nextRetryAtForAttempt(attempt: number, rawError?: any) {
  const retryAfter = Number(rawError?.retryAfter || rawError?.retry_after || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const delayMs = attempt <= 1 ? 30_000 : attempt === 2 ? 120_000 : 300_000;
  return new Date(Date.now() + delayMs).toISOString();
}

function friendlyStyleBibleErrorMessage(code: string, message: string) {
  if (code === 'gateway_timeout_60s') return '上游网关 60 秒超时，当前分段请求仍然过重或通路不可用';
  if (code === 'provider_rate_limited') return '上游模型限流，请稍后自动重试';
  if (code === 'output_incomplete') return '模型输出预算不足，已提高本阶段预算重试';
  if (code === 'style_bible_incomplete') return message || '风格圣经生成结果不完整';
  if (code === 'run_timeout') return '风格圣经生成超过 30 分钟，已停止本次任务';
  return message || '风格圣经生成失败';
}

function errorMeta(error: any) {
  if (!error || typeof error !== 'object') return null;
  return {
    usage: error.usage || null,
    incompleteReason: error.incompleteReason || null,
    incompleteDetails: error.incompleteDetails || null,
  };
}

function parseJsonObject(value: string): any {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeJson(value: any): string {
  try { return JSON.stringify(value || {}); } catch { return '{}'; }
}
