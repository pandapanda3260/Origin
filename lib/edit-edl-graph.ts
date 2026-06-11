import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { UserRow } from './db';
import { getDb } from './db';
import { chatComplete, chatStream, parseJsonLoose, type ChatMessage } from './llm';
import { dataPath } from './runtime-paths';
import {
  SP_GENERATE_EDL,
  buildEdlResult,
  collectEdlGenerationContext,
  normalizeGeneratedEdl,
} from './edit-edl';
import { buildKnowledgeContextForStage } from './knowledge/compile-context';
import { recordKnowledgeContextBestEffort } from './knowledge/context-db';
import { maybeInjectKnowledgePromptBlock } from './knowledge/inject-messages';
import type { KnowledgeContextForStage } from './knowledge/types';

const GRAPH_VERSION = 1;
const MAX_REPAIR_ATTEMPTS = 2;
const CHECKPOINT_FILE = dataPath('langgraph-checkpoints.sqlite');
const PENDING_STATUSES = new Set(['needs_approval', 'version_conflict']);
const TERMINAL_STATUSES = new Set([
  'committed',
  'rejected',
  'rerun_requested',
  'expired',
  'failed_collect',
  'failed_generation',
  'failed_parse',
  'failed_repair',
  'failed_commit',
  'failed_input_changed',
]);

type GraphEmitEvent =
  | { type: 'step'; label: string }
  | { type: 'chunk'; content: string }
  | { type: 'phase'; name: string; extra?: Record<string, any> };

type GraphEmit = (event: GraphEmitEvent) => void;

type StartArgs = {
  user: UserRow;
  projectId: string;
  targetDurationSec: number;
  segments?: any[];
  strictSegments?: boolean;
  auditRunId?: string | null;
  auditSource?: string | null;
  emit?: GraphEmit;
};

type ResumeArgs = {
  user: UserRow;
  threadId: string;
  action: 'approve' | 'reject' | 'discard' | 'rerun';
  emit?: GraphEmit;
};

const EdlGraphState = Annotation.Root({
  runId: Annotation<string>(),
  threadId: Annotation<string>(),
  projectId: Annotation<string>(),
  userId: Annotation<number>(),
  targetDurationSec: Annotation<number>(),
  segments: Annotation<any[]>(),
  strictSegments: Annotation<boolean>(),
  auditRunId: Annotation<string>(),
  auditSource: Annotation<string>(),
  baseEditVersion: Annotation<number>(),
  inputHash: Annotation<string>(),
  clipIds: Annotation<string[]>(),
  rawJson: Annotation<string>(),
  repairAttempts: Annotation<number>(),
  parseError: Annotation<string>(),
  parsedJson: Annotation<any>(),
  timeline: Annotation<any[]>(),
  totalDuration: Annotation<number>(),
  draftResult: Annotation<any>(),
  qcWarnings: Annotation<any[]>(),
  approval: Annotation<any>(),
  conflict: Annotation<any>(),
  commitResult: Annotation<any>(),
  status: Annotation<string>(),
  error: Annotation<string>(),
  createdAt: Annotation<string>(),
  updatedAt: Annotation<string>(),
});

type EdlGraphStateValue = typeof EdlGraphState.State;

let checkpointSaver: SqliteSaver | null = null;

function getCheckpointSaver() {
  if (!checkpointSaver) {
    mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
    checkpointSaver = SqliteSaver.fromConnString(CHECKPOINT_FILE);
  }
  return checkpointSaver;
}

function nowIso() {
  return new Date().toISOString();
}

function expiresAtIso(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getComparableEditVersion(editData: any) {
  return Math.max(
    Number(editData?.version) || 0,
    Number(editData?.edl?.version) || 0,
  );
}

function getProjectData(projectId: string, userId: number) {
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, { data_json: string }>(
      'SELECT data_json FROM projects WHERE id = @id AND owner_id = @uid',
    )
    .get({ id: projectId, uid: userId });
  if (!row) return null;
  try {
    return JSON.parse(row.data_json || '{}');
  } catch {
    return {};
  }
}

function patchProjectData(projectId: string, userId: number, patcher: (data: any) => any | null) {
  const db = getDb();
  let result: any = null;
  const txn = db.transaction(() => {
    const row = db
      .prepare<{ id: string; uid: number }, { data_json: string }>(
        'SELECT data_json FROM projects WHERE id = @id AND owner_id = @uid',
      )
      .get({ id: projectId, uid: userId });
    if (!row) return;
    let data: any = {};
    try { data = JSON.parse(row.data_json || '{}'); } catch { data = {}; }
    const next = patcher(data);
    if (!next) return;
    result = next;
    db.prepare(
      `UPDATE projects
       SET data_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    ).run(JSON.stringify(next), projectId, userId);
  });
  txn.immediate();
  return result;
}

function patchEdlGraphProjection(projectId: string, userId: number, projection: Record<string, any>) {
  patchProjectData(projectId, userId, (data) => {
    const editData = { ...(data.editData || {}) };
    editData.edlGraph = {
      ...(editData.edlGraph || {}),
      ...projection,
      graphVersion: GRAPH_VERSION,
      updatedAt: nowIso(),
    };
    data.editData = editData;
    return data;
  });
}

function listEdlCheckpointThreads() {
  const saver = getCheckpointSaver() as any;
  saver.setup?.();
  try {
    const rows = saver.db
      .prepare("SELECT DISTINCT thread_id FROM checkpoints WHERE thread_id LIKE 'edl:%'")
      .all() as Array<{ thread_id: string }>;
    return rows.map((r) => String(r.thread_id || '')).filter(Boolean);
  } catch {
    return [];
  }
}

export async function reapExpiredEdlGraphRuns() {
  const db = getDb();
  const rows = db
    .prepare<[], { id: string; owner_id: number; data_json: string }>(
      'SELECT id, owner_id, data_json FROM projects',
    )
    .all();
  const now = Date.now();
  const terminalBefore = now - 30 * 24 * 60 * 60 * 1000;
  const referencedThreads = new Set<string>();
  const deleteThreads: string[] = [];
  const update = db.prepare(
    `UPDATE projects
     SET data_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND owner_id = ?`,
  );

  for (const row of rows) {
    let data: any = {};
    try { data = JSON.parse(row.data_json || '{}'); } catch { data = {}; }
    const graph = data?.editData?.edlGraph;
    if (!graph || !graph.threadId) continue;
    referencedThreads.add(String(graph.threadId));

    const status = String(graph.status || '');
    const expiresAt = Date.parse(String(graph.expiresAt || ''));
    const updatedAt = Date.parse(String(graph.updatedAt || ''));
    let changed = false;

    if (PENDING_STATUSES.has(status) && Number.isFinite(expiresAt) && expiresAt < now) {
      data.editData = { ...(data.editData || {}) };
      data.editData.edlGraph = {
        ...graph,
        status: 'expired',
        lastError: 'EDL 草稿确认已过期',
        updatedAt: nowIso(),
      };
      changed = true;
      deleteThreads.push(String(graph.threadId));
    } else if (TERMINAL_STATUSES.has(status) && Number.isFinite(updatedAt) && updatedAt < terminalBefore) {
      deleteThreads.push(String(graph.threadId));
    }

    if (changed) {
      update.run(JSON.stringify(data), row.id, row.owner_id);
    }
  }

  if (deleteThreads.length) {
    const saver = getCheckpointSaver();
    for (const threadId of Array.from(new Set(deleteThreads))) {
      try { await saver.deleteThread(threadId); } catch (e) {
        console.warn('[edl-graph] delete expired checkpoint failed:', threadId, e);
      }
    }
  }

  const orphanThreads = listEdlCheckpointThreads()
    .filter((threadId) => !referencedThreads.has(threadId));
  if (orphanThreads.length) {
    const saver = getCheckpointSaver();
    for (const threadId of orphanThreads) {
      try { await saver.deleteThread(threadId); } catch (e) {
        console.warn('[edl-graph] delete orphan checkpoint failed:', threadId, e);
      }
    }
  }
}

function collectForState(state: EdlGraphStateValue) {
  const projectData = getProjectData(state.projectId, state.userId);
  if (!projectData) return { ok: false as const, error: '项目不存在' };
  const collected = collectEdlGenerationContext({
    projectId: state.projectId,
    userId: state.userId,
    project: projectData,
    body: {
      segments: Array.isArray(state.segments) ? state.segments : [],
      strictSegments: state.strictSegments === true,
    },
    targetDurationSec: Number(state.targetDurationSec) || 30,
    strictSegments: state.strictSegments === true,
  });
  if (!collected.ok) return collected;
  return { ok: true as const, projectData, collected };
}

function commitDraftAtomically(state: EdlGraphStateValue) {
  const draft = state.draftResult;
  if (!draft || !Array.isArray(draft.timeline)) {
    return { ok: false as const, reason: 'missing_draft', error: '缺少可提交的 EDL 草稿' };
  }

  let output:
    | { ok: true; result: any; serverVersion: number }
    | { ok: false; reason: string; error: string; currentVersion?: number } = {
      ok: false,
      reason: 'not_found',
      error: '项目不存在',
    };

  patchProjectData(state.projectId, state.userId, (data) => {
    const editData = { ...(data.editData || {}) };
    const currentVersion = getComparableEditVersion(editData);
    if (currentVersion !== Number(state.baseEditVersion || 0)) {
      output = {
        ok: false,
        reason: 'version_conflict',
        error: '剪辑时间线已被修改，请重新生成或放弃当前草稿',
        currentVersion,
      };
      return null;
    }

    const prevEdl = editData.edl && typeof editData.edl === 'object' ? editData.edl : {};
    const result = {
      ...draft,
      bgm: prevEdl.bgm || null,
      version: (Number(prevEdl.version) || 0) + 1,
    };
    const serverVersion = currentVersion + 1;
    editData.edl = result;
    editData.version = serverVersion;
    if (state.strictSegments === true) {
      editData.lastAutoComposeEdlVersion = Number(result.version) || 0;
    }
    editData.edlGraph = {
      ...(editData.edlGraph || {}),
      runId: state.runId,
      threadId: state.threadId,
      status: 'committed',
      graphVersion: GRAPH_VERSION,
      baseEditVersion: state.baseEditVersion,
      updatedAt: nowIso(),
    };
    data.editData = editData;

    const sbs = Array.isArray(data.storyboards) ? [...data.storyboards] : [];
    const inTl = new Set<number>(
      result.timeline
        .map((e: any) => e?.groupIdx)
        .filter((g: any) => Number.isInteger(g)),
    );
    for (let i = 0; i < sbs.length; i++) {
      const want = inTl.has(i);
      if (sbs[i] && !!sbs[i].importedToEdit !== want) {
        sbs[i] = { ...sbs[i], importedToEdit: want };
      }
    }
    data.storyboards = sbs;

    output = { ok: true, result, serverVersion };
    return data;
  });

  return output;
}

function emitStep(emit: GraphEmit | undefined, label: string) {
  emit?.({ type: 'step', label });
}

function emitPhase(emit: GraphEmit | undefined, name: string, extra?: Record<string, any>) {
  emit?.({ type: 'phase', name, extra });
}

function createGraph(user: UserRow, emit?: GraphEmit) {
  const graph = new StateGraph(EdlGraphState)
    .addNode('collect_context', async (state) => {
      emitPhase(emit, 'collect_context');
      const loaded = collectForState(state);
      if (!loaded.ok) {
        return { status: 'failed_collect', error: loaded.error, updatedAt: nowIso() };
      }
      const baseEditVersion = getComparableEditVersion(loaded.projectData.editData || {});
      return {
        baseEditVersion,
        inputHash: loaded.collected.inputHash,
        clipIds: loaded.collected.clipIds,
        repairAttempts: 0,
        status: 'context_ready',
        updatedAt: nowIso(),
      };
    })
    .addNode('generate_raw_edl', async (state) => {
      if (state.rawJson) {
        return { status: 'raw_ready', updatedAt: nowIso() };
      }
      emitPhase(emit, 'generate_raw_edl');
      const loaded = collectForState(state);
      if (!loaded.ok) return { status: 'failed_collect', error: loaded.error, updatedAt: nowIso() };
      if (state.inputHash && loaded.collected.inputHash !== state.inputHash) {
        return { status: 'failed_input_changed', error: '输入片段已变化，请重新生成 EDL', updatedAt: nowIso() };
      }

      let raw = '';
      let knowledgeContext: KnowledgeContextForStage | null = null;
      try {
        emitStep(emit, '正在生成剪辑方案…');
        const clipCount = loaded.collected.ctx.clips.length;
        const edlMaxTokens = Math.min(12_000, Math.max(4_000, clipCount * 800));
        let messages: ChatMessage[] = [
          { role: 'system', content: SP_GENERATE_EDL },
          { role: 'user', content: JSON.stringify(loaded.collected.ctx) },
        ];
        try {
          const context = buildKnowledgeContextForStage({
            ownerId: state.userId,
            project: {
              ...(loaded.projectData || {}),
              id: state.projectId,
            },
            stage: 'edit_edl',
            stageTarget: {
              source: state.auditSource || (state.strictSegments ? 'edl_graph_strict' : 'edl_graph'),
              targetDurationSec: Number(state.targetDurationSec) || 30,
              inputHash: loaded.collected.inputHash,
              clipIds: loaded.collected.clipIds,
              clipCount,
              strictSegments: state.strictSegments === true,
            },
            runId: state.auditRunId || state.runId,
          });
          const injected = maybeInjectKnowledgePromptBlock({ messages, context });
          messages = injected.messages;
          knowledgeContext = injected.context;
        } catch (error) {
          console.warn('[edl-graph] knowledge context injection skipped:', error);
        }
        await chatStream(
          user,
          messages,
          {
            temperature: 0.5,
            responseFormat: 'json_object',
            maxTokens: edlMaxTokens,
            modelRole: 'structured',
            reasoningEffort: 'none',
            traceName: 'edl-graph.generate',
            tokenContext: {
              projectId: state.projectId,
              projectTitleSnapshot: loaded.projectData?.title || null,
              requestPath: 'edit_edl_graph',
              routeName: 'edit-edl.graph',
              moduleKey: 'edit',
              moduleLabel: '剪辑页',
              featureKey: 'edl_graph_generate',
              featureLabel: '剪辑方案生成',
              callItemType: 'edl_graph',
              callItemId: state.threadId,
              callItemLabel: loaded.projectData?.title || state.projectId,
              runId: state.auditRunId || state.runId,
              operationKey: `edl-graph:${state.threadId}:generate`,
              operationLabel: '剪辑方案生成',
            },
          },
          (delta) => {
            raw += delta;
            emit?.({ type: 'chunk', content: delta });
          },
        );
        if (knowledgeContext) {
          recordKnowledgeContextBestEffort({
            ownerId: state.userId,
            projectId: state.projectId,
            context: knowledgeContext,
            runId: state.auditRunId || state.runId,
          });
        }
        return { rawJson: raw, status: 'raw_ready', updatedAt: nowIso() };
      } catch (e: any) {
        return { status: 'failed_generation', error: `EDL 生成失败：${e?.message || String(e)}`, updatedAt: nowIso() };
      }
    })
    .addNode('parse_and_normalize', async (state) => {
      emitPhase(emit, 'parse_and_normalize');
      let json: any = {};
      try {
        json = parseJsonLoose<any>(state.rawJson || '');
      } catch (e: any) {
        const attempts = Number(state.repairAttempts) || 0;
        return {
          status: attempts < MAX_REPAIR_ATTEMPTS ? 'needs_repair' : 'failed_parse',
          parseError: e?.message || 'AI 输出无法解析为 JSON',
          error: attempts < MAX_REPAIR_ATTEMPTS ? '' : 'AI 输出无法解析为 JSON，请稍后重试',
          updatedAt: nowIso(),
        };
      }

      const loaded = collectForState(state);
      if (!loaded.ok) return { status: 'failed_collect', error: loaded.error, updatedAt: nowIso() };
      if (state.inputHash && loaded.collected.inputHash !== state.inputHash) {
        return { status: 'failed_input_changed', error: '输入片段已变化，请重新生成 EDL', updatedAt: nowIso() };
      }

      const { timeline, totalDuration } = normalizeGeneratedEdl(
        json,
        loaded.collected.clips,
        loaded.collected.segTags,
      );
      const prevEdl = loaded.projectData?.editData?.edl && typeof loaded.projectData.editData.edl === 'object'
        ? loaded.projectData.editData.edl
        : {};
      const draftResult = buildEdlResult(json, timeline, totalDuration, prevEdl);
      return {
        parsedJson: json,
        timeline,
        totalDuration,
        draftResult,
        status: 'draft_ready',
        error: '',
        updatedAt: nowIso(),
      };
    })
    .addNode('repair_json', async (state) => {
      emitPhase(emit, 'repair_json', { attempt: (Number(state.repairAttempts) || 0) + 1 });
      const attempts = Number(state.repairAttempts) || 0;
      if (attempts >= MAX_REPAIR_ATTEMPTS) {
        return {
          status: 'failed_parse',
          error: 'AI 输出无法解析为 JSON，请稍后重试',
          updatedAt: nowIso(),
        };
      }
      const loaded = collectForState(state);
      const projectTitle = loaded.ok ? loaded.projectData?.title || null : null;
      try {
        emitStep(emit, '正在修复剪辑方案 JSON…');
        const repaired = await chatComplete(
          user,
          [
            {
              role: 'system',
              content: '你是 JSON 修复器。只输出严格 JSON，不要解释，不要 markdown。保持原始语义，修复截断、尾逗号、代码围栏或多余文本。',
            },
            {
              role: 'user',
              content: JSON.stringify({
                expectedShape: { edl: [], duration: 0, narrative: '', pacingPlan: '' },
                parseError: state.parseError || '',
                raw: state.rawJson || '',
              }),
            },
          ],
          {
            temperature: 0,
            responseFormat: 'json_object',
            maxTokens: 12_000,
            modelRole: 'structured',
            reasoningEffort: 'none',
            traceName: 'edl-graph.repair',
            tokenContext: {
              projectId: state.projectId,
              projectTitleSnapshot: projectTitle,
              requestPath: 'edit_edl_graph',
              routeName: 'edit-edl.graph',
              moduleKey: 'edit',
              moduleLabel: '剪辑页',
              featureKey: 'edl_graph_repair',
              featureLabel: '剪辑方案 JSON 修复',
              callItemType: 'edl_graph',
              callItemId: state.threadId,
              callItemLabel: projectTitle || state.projectId,
              runId: state.auditRunId || state.runId,
              operationKey: `edl-graph:${state.threadId}:repair:${attempts + 1}`,
              operationLabel: '剪辑方案 JSON 修复',
            },
          },
        );
        return {
          rawJson: repaired,
          repairAttempts: attempts + 1,
          status: 'raw_ready',
          parseError: '',
          updatedAt: nowIso(),
        };
      } catch (e: any) {
        return {
          repairAttempts: attempts + 1,
          status: 'failed_repair',
          error: `EDL JSON 修复失败：${e?.message || String(e)}`,
          updatedAt: nowIso(),
        };
      }
    })
    .addNode('qc_edl', async (state) => {
      emitPhase(emit, 'qc_edl');
      const warnings: any[] = [];
      const timeline = Array.isArray(state.timeline) ? state.timeline : [];
      if (!timeline.length) {
        warnings.push({ level: 'error', message: 'EDL 时间线为空' });
      }
      const seen = new Set<number>();
      for (const seg of timeline) {
        if (!seg || !Number.isInteger(seg.groupIdx)) {
          warnings.push({ level: 'warn', message: '存在缺少 groupIdx 的时间线片段' });
          continue;
        }
        if (seen.has(seg.groupIdx)) {
          warnings.push({ level: 'warn', message: `groupIdx ${seg.groupIdx} 在 EDL 中重复出现` });
        }
        seen.add(seg.groupIdx);
        if ((Number(seg.duration) || 0) <= 0) {
          warnings.push({ level: 'error', message: `groupIdx ${seg.groupIdx} 的 duration 非法` });
        }
      }
      return { qcWarnings: warnings, status: 'qc_ready', updatedAt: nowIso() };
    })
    .addNode('human_confirm', async (state) => {
      const approval = interrupt({
        type: 'edl_approval',
        runId: state.runId,
        threadId: state.threadId,
        projectId: state.projectId,
        draftResult: state.draftResult,
        qcWarnings: state.qcWarnings || [],
        expiresAt: expiresAtIso(7),
      }) as any;
      const action = String(approval?.action || '');
      if (action === 'approve') {
        return { approval, status: 'approved', updatedAt: nowIso() };
      }
      return {
        approval,
        status: 'rejected',
        error: action === 'reject' ? '用户已放弃 EDL 草稿' : 'EDL 草稿未被批准',
        updatedAt: nowIso(),
      };
    })
    .addNode('commit_edl', async (state) => {
      emitPhase(emit, 'commit_edl');
      if (state.commitResult?.ok) {
        return { status: 'committed', updatedAt: nowIso() };
      }
      const committed = commitDraftAtomically(state);
      if (!committed.ok) {
        if (committed.reason === 'version_conflict') {
          return {
            status: 'version_conflict',
            conflict: committed,
            error: committed.error,
            updatedAt: nowIso(),
          };
        }
        return { status: 'failed_commit', error: committed.error, updatedAt: nowIso() };
      }
      return {
        status: 'committed',
        commitResult: committed,
        updatedAt: nowIso(),
      };
    })
    .addNode('version_conflict', async (state) => {
      const decision = interrupt({
        type: 'edl_version_conflict',
        runId: state.runId,
        threadId: state.threadId,
        projectId: state.projectId,
        conflict: state.conflict,
        message: '剪辑时间线已被修改，不能覆盖用户现有编辑。',
      }) as any;
      const action = String(decision?.action || '');
      if (action === 'rerun') {
        return {
          approval: decision,
          status: 'rerun_requested',
          error: '用户选择基于当前时间线重跑',
          updatedAt: nowIso(),
        };
      }
      return {
        approval: decision,
        status: 'rejected',
        error: '版本冲突，已放弃当前 EDL 草稿',
        updatedAt: nowIso(),
      };
    })
    .addEdge(START, 'collect_context')
    .addConditionalEdges('collect_context', (state) => (
      state.status === 'context_ready' ? 'generate_raw_edl' : END
    ))
    .addConditionalEdges('generate_raw_edl', (state) => (
      state.status === 'raw_ready' ? 'parse_and_normalize' : END
    ))
    .addConditionalEdges('parse_and_normalize', (state) => {
      if (state.status === 'draft_ready') return 'qc_edl';
      if (state.status === 'needs_repair') return 'repair_json';
      return END;
    })
    .addEdge('repair_json', 'parse_and_normalize')
    .addEdge('qc_edl', 'human_confirm')
    .addConditionalEdges('human_confirm', (state) => (
      state.status === 'approved' ? 'commit_edl' : END
    ))
    .addConditionalEdges('commit_edl', (state) => (
      state.status === 'version_conflict' ? 'version_conflict' : END
    ))
    .addEdge('version_conflict', END)
    .compile({
      checkpointer: getCheckpointSaver(),
      name: 'edl-draft-graph',
    });

  return graph;
}

function graphConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

function summarizeOutput(output: any) {
  const interrupts = Array.isArray(output?.__interrupt__) ? output.__interrupt__ : [];
  return {
    needsApproval: interrupts.length > 0,
    interrupt: interrupts[0]?.value || null,
    runId: output?.runId,
    threadId: output?.threadId,
    projectId: output?.projectId,
    status: output?.status || (interrupts.length ? 'needs_approval' : 'unknown'),
    draftResult: output?.draftResult,
    qcWarnings: output?.qcWarnings || [],
    conflict: output?.conflict || null,
    commitResult: output?.commitResult || null,
    error: output?.error || '',
    baseEditVersion: output?.baseEditVersion,
  };
}

function persistProjection(summary: ReturnType<typeof summarizeOutput>, userId: number) {
  if (!summary.projectId || !summary.threadId || !summary.runId) return;
  patchEdlGraphProjection(summary.projectId, userId, {
    runId: summary.runId,
    threadId: summary.threadId,
    status: summary.needsApproval
      ? (summary.interrupt?.type === 'edl_version_conflict' ? 'version_conflict' : 'needs_approval')
      : summary.status,
    baseEditVersion: summary.baseEditVersion,
    lastError: summary.error || '',
    expiresAt: summary.needsApproval ? summary.interrupt?.expiresAt : undefined,
  });
}

export function createEdlGraphThreadId(userId: number, projectId: string, runId = randomUUID()) {
  return {
    runId,
    threadId: `edl:${userId}:${projectId}:${runId}`,
  };
}

export async function startEdlGraphRun(args: StartArgs) {
  await reapExpiredEdlGraphRuns();
  const { runId, threadId } = createEdlGraphThreadId(args.user.id, args.projectId);
  patchEdlGraphProjection(args.projectId, args.user.id, {
    runId,
    threadId,
    status: 'running',
    baseEditVersion: null,
    lastError: '',
  });

  const graph = createGraph(args.user, args.emit);
  const output = await graph.invoke({
    runId,
    threadId,
    projectId: args.projectId,
    userId: args.user.id,
    targetDurationSec: args.targetDurationSec,
    segments: Array.isArray(args.segments) ? args.segments : [],
    strictSegments: args.strictSegments === true,
    auditRunId: args.auditRunId || runId,
    auditSource: args.auditSource || '',
    repairAttempts: 0,
    status: 'started',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }, graphConfig(threadId));
  const summary = summarizeOutput(output);
  persistProjection(summary, args.user.id);
  return summary;
}

export async function resumeEdlGraphRun(args: ResumeArgs) {
  await reapExpiredEdlGraphRuns();
  const graph = createGraph(args.user, args.emit);
  const config = graphConfig(args.threadId);
  const snapshot = await graph.getState(config);
  const values: any = snapshot?.values || {};
  if (!values.threadId) {
    throw new Error('EDL graph run 不存在或已过期');
  }
  if (Number(values.userId) !== args.user.id) {
    throw new Error('无权恢复该 EDL graph run');
  }

  const output = await graph.invoke(
    new Command({
      resume: {
        action: args.action,
        confirmedAt: nowIso(),
      },
    }),
    config,
  );
  const summary = summarizeOutput(output);
  persistProjection(summary, args.user.id);
  return summary;
}

export async function getEdlGraphSnapshot(user: UserRow, threadId: string) {
  const graph = createGraph(user);
  const snapshot = await graph.getState(graphConfig(threadId));
  const values: any = snapshot?.values || {};
  if (!values.threadId) return null;
  if (Number(values.userId) !== user.id) {
    throw new Error('无权读取该 EDL graph run');
  }
  return {
    values,
    next: snapshot.next,
    tasks: snapshot.tasks,
  };
}
