import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { analyzeUsableSegments } from '@/lib/edit-analyze';
import {
  cleanStaleRunningComposeRuns,
  collectEditSegmentsForCompose,
  computeSegmentFingerprint,
  createComposeRun,
  getComposeBootTs,
  hasActiveComposeRun,
  markExportFailureInEditData,
  pushEdlHistory,
  updateComposeRun,
  upsertComposeRun,
  RUNNING_STALE_MS,
  type AutoComposePhase,
  type ComposeRun,
  type RecoverableFrom,
  type UsableEditSegment,
} from '@/lib/edit-auto-compose-state';
import { markExportTaskIgnored, startEditExport } from '@/lib/edit-export';
import { startEdlGraphRun, resumeEdlGraphRun } from '@/lib/edit-edl-graph';
import { getProjectByIdForUser, patchProjectForUser } from '@/lib/projects-db';
import { sseResponse, type SSEWriter } from '@/lib/sse';
import { recordKnowledgeContextBestEffort } from '@/lib/knowledge/context-db';
import type { KnowledgeContextForStage } from '@/lib/knowledge/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RetryFrom = 'analyze' | 'edl' | 'export';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendPhase(writer: SSEWriter, phase: AutoComposePhase, message: string) {
  writer.event('phase', { phase, message });
}

function recoverableFromPhase(phase: AutoComposePhase): RecoverableFrom {
  if (phase === 'export') return 'export';
  if (phase === 'edl') return 'edl';
  return 'analyze';
}

function normalizeRetryFrom(value: any): RetryFrom {
  const v = String(value || '');
  if (v === 'export' || v === 'edl' || v === 'analyze') return v;
  return 'analyze';
}

function mergeSkippedReasons(skipped: any[], stale: any[]) {
  return [...(Array.isArray(skipped) ? skipped : []), ...(Array.isArray(stale) ? stale : [])];
}

function targetDurationFromSegments(segments: UsableEditSegment[]) {
  return segments.reduce((sum, seg) => sum + (Number(seg.videoDurationSec ?? seg.duration) || 0), 0);
}

function hasUsableEdl(editData: any) {
  return Array.isArray(editData?.edl?.timeline) && editData.edl.timeline.length > 0;
}

function segmentTagsMatch(editData: any, fingerprint: string) {
  return !!fingerprint && editData?.segmentTags?.sourceFingerprint === fingerprint;
}

function patchRun(projectId: string, userId: number, runId: string, patch: Partial<ComposeRun>) {
  return patchProjectForUser(projectId, userId, (current) => {
    const editData = { ...(current.editData || {}) };
    const updated = updateComposeRun(editData, runId, patch);
    return { editData: updated.editData };
  }) as any;
}

function failRun(args: {
  writer: SSEWriter;
  projectId: string;
  userId: number;
  runId?: string;
  phase: AutoComposePhase;
  code: string;
  message: string;
  recoverableFrom: RecoverableFrom;
  exportTaskId?: string;
}) {
  if (args.runId) {
    patchProjectForUser(args.projectId, args.userId, (current) => {
      let editData = { ...(current.editData || {}) };
      if (args.exportTaskId) {
        editData = markExportFailureInEditData(editData, {
          exportTaskId: args.exportTaskId,
          errorCode: args.code,
          errorMessage: args.message,
        });
      }
      const updated = updateComposeRun(editData, args.runId!, {
        status: 'failed',
        phase: args.phase,
        recoverableFrom: args.recoverableFrom,
        errorCode: args.code,
        errorMessage: args.message,
      });
      return { editData: updated.editData };
    });
  } else if (args.exportTaskId) {
    patchProjectForUser(args.projectId, args.userId, (current) => ({
      editData: markExportFailureInEditData(current.editData || {}, {
        exportTaskId: args.exportTaskId!,
        errorCode: args.code,
        errorMessage: args.message,
      }),
    }));
  }
  args.writer.fail({
    phase: args.phase,
    code: args.code,
    message: args.message,
    error: args.message,
    recoverableFrom: args.recoverableFrom,
  });
}

function getExportRow(taskId: string, userId: number) {
  return getDb()
    .prepare<{ id: string; uid: number }, any>('SELECT * FROM exports WHERE id = @id AND owner_id = @uid')
    .get({ id: taskId, uid: userId });
}

function ensureLegacyBaseline(editData: any) {
  let next = { ...(editData || {}) };
  const hasBaseline = Number.isFinite(Number(next.lastAutoComposeEdlVersion));
  const edlVersion = Number(next.edl?.version) || 0;
  if (hasBaseline) return next;
  if (hasUsableEdl(next)) {
    next = pushEdlHistory(next, { source: 'legacy', edl: next.edl });
    next.lastAutoComposeEdlVersion = edlVersion;
  } else {
    next.lastAutoComposeEdlVersion = 0;
  }
  return next;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response(
      `data: ${JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', error: 'unauthorized' })}\n\n`,
      { status: 401, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const projectId = String(body?.projectId || '').trim();
  const mode = body?.mode === 'retry' ? 'retry' : 'start';

  return sseResponse(async (writer) => {
    if (!projectId) {
      writer.fail({ phase: 'preflight', code: 'MISSING_PROJECT_ID', error: '缺 projectId', message: '缺 projectId', recoverableFrom: 'analyze' });
      return;
    }

    sendPhase(writer, 'preflight', '检查片段中');

    const init: {
      kind?: string;
      runId?: string;
      run?: ComposeRun;
      project?: any;
      usableSegments?: UsableEditSegment[];
      skippedReasons?: any[];
      fingerprint?: string;
      partial?: boolean;
      startFrom?: RetryFrom;
      oldExportTaskId?: string;
      message?: string;
    } = {};

    const patched = patchProjectForUser(projectId, user.id, (current) => {
      let editData = ensureLegacyBaseline(current.editData || {});
      // bootTs：心跳早于本次进程启动的 running 任务 = 重启孤儿，立即清掉，
      // 不再让用户吃 10 分钟 ALREADY_RUNNING（分析/方案阶段没有 exports-reap 兜底）。
      const cleaned = cleanStaleRunningComposeRuns(editData, RUNNING_STALE_MS, getComposeBootTs());
      editData = cleaned.editData;

      if (hasActiveComposeRun(editData)) {
        init.kind = 'already_running';
        return { editData };
      }

      const edlVersion = Number(editData?.edl?.version) || 0;
      const lastAuto = Number(editData?.lastAutoComposeEdlVersion) || 0;
      if (edlVersion > lastAuto) {
        init.kind = 'manual_timeline';
        return { editData };
      }

      const preflight = collectEditSegmentsForCompose({ ...current, editData });
      const skippedReasons = mergeSkippedReasons(preflight.skippedSegments, preflight.staleSegments);
      const fingerprint = computeSegmentFingerprint(preflight.usableSegments);
      const partial = skippedReasons.length > 0;
      init.usableSegments = preflight.usableSegments;
      init.skippedReasons = skippedReasons;
      init.fingerprint = fingerprint;
      init.partial = partial;

      let run: ComposeRun | null = null;
      let startFrom: RetryFrom = 'analyze';
      if (mode === 'retry') {
        const requestedRunId = String(body?.runId || '').trim();
        const runs = Array.isArray(editData.composeRuns) ? editData.composeRuns : [];
        const existing = runs.find((r: any) => r?.runId === requestedRunId);
        if (!requestedRunId || !existing) {
          init.kind = 'run_not_found';
          return { editData };
        }
        startFrom = normalizeRetryFrom(body?.retryFrom || existing.recoverableFrom);
        if (startFrom === 'export' && !hasUsableEdl(editData)) startFrom = 'edl';
        if ((startFrom === 'edl' || startFrom === 'export') && !segmentTagsMatch(editData, fingerprint)) {
          startFrom = 'analyze';
        }
        if (startFrom === 'export' && existing.exportTaskId) init.oldExportTaskId = existing.exportTaskId;
        run = {
          ...existing,
          status: preflight.usableSegments.length ? 'running' : 'failed',
          phase: 'preflight',
          recoverableFrom: preflight.usableSegments.length ? undefined : 'analyze',
          partial,
          skippedReasons,
          segmentFingerprint: fingerprint,
          warnings: Array.isArray(existing.warnings) ? existing.warnings : [],
          errorCode: preflight.usableSegments.length ? undefined : 'NO_USABLE_SEGMENTS',
          errorMessage: preflight.usableSegments.length ? undefined : '当前没有可用视频片段',
        };
      } else {
        run = createComposeRun({ segmentFingerprint: fingerprint, partial, skippedReasons });
        if (!preflight.usableSegments.length) {
          run.status = 'failed';
          run.recoverableFrom = 'analyze';
          run.errorCode = 'NO_USABLE_SEGMENTS';
          run.errorMessage = '当前没有可用视频片段';
        }
      }

      if (!run) {
        init.kind = 'run_not_found';
        return { editData };
      }
      editData = upsertComposeRun(editData, run);
      init.kind = preflight.usableSegments.length ? 'ok' : 'no_usable_segments';
      init.runId = run.runId;
      init.run = run;
      init.startFrom = startFrom;
      return { editData };
    }) as any;

    if (!patched) {
      writer.fail({ phase: 'preflight', code: 'PROJECT_NOT_FOUND', error: '项目不存在', message: '项目不存在', recoverableFrom: 'analyze' });
      return;
    }

    if (init.kind === 'already_running') {
      writer.fail({
        phase: 'preflight',
        code: 'ALREADY_RUNNING',
        error: '已有一键成片任务正在运行',
        message: '已有一键成片任务正在运行',
        recoverableFrom: 'export',
      });
      return;
    }
    if (init.kind === 'manual_timeline') {
      writer.fail({
        phase: 'preflight',
        code: 'MANUAL_TIMELINE_EDIT_DETECTED',
        error: '检测到时间线被手工修改',
        message: '检测到时间线被手工修改',
        recoverableFrom: 'edl',
      });
      return;
    }
    if (init.kind === 'run_not_found') {
      writer.fail({ phase: 'preflight', code: 'RUN_NOT_FOUND', error: '重试记录不存在', message: '重试记录不存在', recoverableFrom: 'analyze' });
      return;
    }

    const runId = init.runId!;
    const usableSegments = init.usableSegments || [];
    const skippedReasons = init.skippedReasons || [];
    const fingerprint = init.fingerprint || computeSegmentFingerprint(usableSegments);
    const partial = init.partial === true;
    writer.event('preflight_result', {
      usable: usableSegments.length,
      skipped: skippedReasons.filter((s: any) => !String(s.reason || '').includes('stale')).length,
      stale: skippedReasons.filter((s: any) => String(s.reason || '').includes('stale')).length,
      partial,
      skippedReasons,
    });

    if (init.kind === 'no_usable_segments') {
      failRun({
        writer,
        projectId,
        userId: user.id,
        runId,
        phase: 'preflight',
        code: 'NO_USABLE_SEGMENTS',
        message: '当前没有可用视频片段',
        recoverableFrom: 'analyze',
      });
      return;
    }

    let project = getProjectByIdForUser(projectId, user.id) as any;
    let startFrom = init.startFrom || 'analyze';

    if (startFrom === 'analyze' || !segmentTagsMatch(project?.editData || {}, fingerprint)) {
      sendPhase(writer, 'analyze', '分析节奏中');
      patchRun(projectId, user.id, runId, { status: 'running', phase: 'analyze' });
      let segmentTags: any;
      let analyzeKnowledgeContext: KnowledgeContextForStage | null = null;
      try {
        segmentTags = await analyzeUsableSegments({
          user,
          project,
          usableSegments,
          knowledge: {
            ownerId: user.id,
            projectId,
            runId,
            stageTarget: {
              source: 'auto_compose',
              usableSegmentCount: usableSegments.length,
              partial,
              fingerprint,
            },
          },
          onKnowledgeContext: (context) => { analyzeKnowledgeContext = context; },
          onStep: (label) => writer.event('step', { phase: 'analyze', label }),
        });
      } catch (e: any) {
        failRun({
          writer,
          projectId,
          userId: user.id,
          runId,
          phase: 'analyze',
          code: 'ANALYZE_FAILED',
          message: e?.message || String(e),
          recoverableFrom: 'analyze',
        });
        return;
      }

      project = patchProjectForUser(projectId, user.id, (current) => {
        const editData = { ...(current.editData || {}) };
        editData.segmentTags = { ...segmentTags, sourceFingerprint: fingerprint };
        editData.version = (Number(editData.version) || 0) + 1;
        const updated = updateComposeRun(editData, runId, { status: 'running', phase: 'analyze' });
        return { editData: updated.editData };
      }) as any;
      if (analyzeKnowledgeContext) {
        recordKnowledgeContextBestEffort({
          ownerId: user.id,
          projectId,
          context: analyzeKnowledgeContext,
          runId,
        });
      }
      startFrom = 'edl';
    } else {
      writer.event('phase', { phase: 'analyze', message: '复用已有分析结果' });
    }

    const warnings: any[] = [];
    if (startFrom !== 'export') {
      sendPhase(writer, 'edl', '生成剪辑方案中');
      patchRun(projectId, user.id, runId, { status: 'running', phase: 'edl' });
      project = patchProjectForUser(projectId, user.id, (current) => {
        let editData = { ...(current.editData || {}) };
        const edlVersion = Number(editData?.edl?.version) || 0;
        const lastAuto = Number(editData?.lastAutoComposeEdlVersion) || 0;
        if (edlVersion > lastAuto) return { editData };
        if (hasUsableEdl(editData)) {
          const existingHistory = Array.isArray(editData.edlHistory) ? editData.edlHistory : [];
          const existingSnapshot = existingHistory.find((item: any) => Number(item?.version) === edlVersion);
          const source = existingSnapshot?.source === 'manual' || existingSnapshot?.source === 'legacy'
            ? existingSnapshot.source
            : 'auto-compose';
          editData = pushEdlHistory(editData, { source, fingerprint, edl: editData.edl });
        }
        return { editData };
      }) as any;

      const latestEditData = project?.editData || {};
      if ((Number(latestEditData?.edl?.version) || 0) > (Number(latestEditData?.lastAutoComposeEdlVersion) || 0)) {
        failRun({
          writer,
          projectId,
          userId: user.id,
          runId,
          phase: 'edl',
          code: 'MANUAL_TIMELINE_EDIT_DETECTED',
          message: '检测到时间线被手工修改',
          recoverableFrom: 'edl',
        });
        return;
      }

      let graphResult: any;
      try {
        graphResult = await startEdlGraphRun({
          user,
          projectId,
          segments: usableSegments,
          strictSegments: true,
          targetDurationSec: targetDurationFromSegments(usableSegments),
          auditRunId: runId,
          auditSource: 'auto_compose',
        });
        warnings.push(...(Array.isArray(graphResult?.qcWarnings) ? graphResult.qcWarnings : []));
        if (graphResult?.needsApproval) {
          const interruptType = graphResult?.interrupt?.type || '';
          if (graphResult?.conflict || interruptType === 'edl_version_conflict') {
            throw Object.assign(new Error('剪辑时间线已被修改，不能覆盖用户现有编辑。'), {
              code: 'EDL_VERSION_CONFLICT',
              recoverableFrom: 'edl',
            });
          }
          if (interruptType !== 'edl_approval') {
            throw Object.assign(new Error('未知 EDL 中断状态'), { code: 'EDL_INTERRUPT_UNKNOWN', recoverableFrom: 'edl' });
          }
          graphResult = await resumeEdlGraphRun({
            user,
            threadId: graphResult.threadId,
            action: 'approve',
          });
          warnings.push(...(Array.isArray(graphResult?.qcWarnings) ? graphResult.qcWarnings : []));
        }
        if (graphResult?.needsApproval || graphResult?.conflict || graphResult?.interrupt?.type === 'edl_version_conflict') {
          const interruptType = graphResult?.interrupt?.type || '';
          if (interruptType && interruptType !== 'edl_version_conflict') {
            console.warn('[auto-compose] unexpected graph interrupt after resume:', interruptType, {
              runId,
              projectId,
              status: graphResult?.status,
            });
            throw Object.assign(new Error('未知 EDL 中断状态'), {
              code: 'EDL_INTERRUPT_UNKNOWN',
              recoverableFrom: 'edl',
            });
          }
          throw Object.assign(new Error('剪辑时间线已被修改，不能覆盖用户现有编辑。'), {
            code: 'EDL_VERSION_CONFLICT',
            recoverableFrom: 'edl',
          });
        }
        if (!graphResult?.commitResult?.ok) {
          throw Object.assign(new Error(graphResult?.error || 'EDL 提交失败'), { code: 'EDL_FAILED', recoverableFrom: 'edl' });
        }
      } catch (e: any) {
        failRun({
          writer,
          projectId,
          userId: user.id,
          runId,
          phase: 'edl',
          code: e?.code || 'EDL_FAILED',
          message: e?.message || String(e),
          recoverableFrom: e?.recoverableFrom || 'edl',
        });
        return;
      }

      project = patchProjectForUser(projectId, user.id, (current) => {
        const editData = { ...(current.editData || {}) };
        const edlVersion = Number(editData?.edl?.version) || 0;
        const updated = updateComposeRun(editData, runId, {
          status: 'running',
          phase: 'edl',
          warnings,
          edlVersion,
        });
        return { editData: updated.editData };
      }) as any;
    } else {
      writer.event('phase', { phase: 'edl', message: '复用已有剪辑方案' });
      project = patchProjectForUser(projectId, user.id, (current) => {
        const editData = { ...(current.editData || {}) };
        const updated = updateComposeRun(editData, runId, {
          status: 'running',
          phase: 'edl',
          edlVersion: Number(editData?.edl?.version) || 0,
        });
        return { editData: updated.editData };
      });
    }

    sendPhase(writer, 'export', '导出成片中');
    if (init.oldExportTaskId) {
      markExportTaskIgnored({ userId: user.id, taskId: init.oldExportTaskId, reason: `replaced by auto-compose retry ${runId}` });
    }

    let exportTaskId = '';
    let exportedEdlSignature = '';
    let exportedEdlSignatureMeta: any = null;
    const exportEdlVersion = Number(project?.editData?.edl?.version) || 0;
    try {
      const exportResult = await startEditExport({
        user,
        projectId,
        project,
        edl: project?.editData?.edl,
        edlVersion: exportEdlVersion,
        composeMeta: { runId, partial, skippedReasons, segmentFingerprint: fingerprint, warnings },
        filenameSuffix: partial ? 'partial' : undefined,
      });
      exportTaskId = exportResult.taskId;
      exportedEdlSignature = String((exportResult as any).exportedEdlSignature || '');
      exportedEdlSignatureMeta = (exportResult as any).exportedEdlSignatureMeta || null;
      writer.event('export_started', { taskId: exportTaskId });
      patchProjectForUser(projectId, user.id, (current) => {
        const editData = { ...(current.editData || {}) };
        editData.exportTaskId = exportTaskId;
        editData.exportUrl = '';
        const updated = updateComposeRun(editData, runId, {
          status: 'running',
          phase: 'export',
          exportTaskId,
          warnings,
        });
        return { editData: updated.editData };
      });
    } catch (e: any) {
      failRun({
        writer,
        projectId,
        userId: user.id,
        runId,
        phase: 'export',
        code: e?.payload?.errorCode || 'EXPORT_START_FAILED',
        message: e?.message || String(e),
        recoverableFrom: 'export',
      });
      return;
    }

    const startedAt = Date.now();
    let lastProgress = -1;
    let lastHeartbeatMs = Date.now();
    while (Date.now() - startedAt < 2 * 60 * 60 * 1000) {
      const row = getExportRow(exportTaskId, user.id);
      if (!row) {
        failRun({
          writer,
          projectId,
          userId: user.id,
          runId,
          phase: 'export',
          code: 'EXPORT_TASK_MISSING',
          message: '导出任务记录消失',
          recoverableFrom: 'export',
          exportTaskId,
        });
        return;
      }
      const status = String(row.status || '');
      const progress = Number(row.progress || 0);
      if (progress !== lastProgress) {
        lastProgress = progress;
        if (!writer.isClosed()) writer.event('export_progress', { taskId: exportTaskId, progress });
        patchRun(projectId, user.id, runId, { status: 'running', phase: 'export', exportTaskId });
        lastHeartbeatMs = Date.now();
      } else if (Date.now() - lastHeartbeatMs >= 30_000) {
        // 心跳保活：ffmpeg 长阶段进度可能 10 分钟不动，若不刷 heartbeatAt，
        // 活着的任务会被 cleanStaleRunningComposeRuns / 前端 10 分钟窗口误判成僵尸。
        patchRun(projectId, user.id, runId, { status: 'running', phase: 'export', exportTaskId });
        lastHeartbeatMs = Date.now();
      }
      if (status === 'completed') {
        const exportUrl = `/api/edit/export-file/${exportTaskId}`;
        const exportedEdlVersion = Number.isFinite(Number(row.edl_version)) ? Number(row.edl_version) : exportEdlVersion;
        patchProjectForUser(projectId, user.id, (current) => {
          const editData = { ...(current.editData || {}) };
          editData.exportTaskId = exportTaskId;
          editData.exportUrl = exportUrl;
          editData.exportedEdlVersion = exportedEdlVersion;
          if (exportedEdlSignature) editData.exportedEdlSignature = exportedEdlSignature;
          if (exportedEdlSignatureMeta) editData.exportedEdlSignatureMeta = exportedEdlSignatureMeta;
          const updated = updateComposeRun(editData, runId, {
            status: partial ? 'partial' : 'completed',
            phase: 'export',
            exportTaskId,
            exportUrl,
            warnings,
          });
          return { editData: updated.editData };
        });
        if (!writer.isClosed()) {
          writer.done({ runId, exportTaskId, exportUrl, exportedEdlVersion, exportedEdlSignature, exportedEdlSignatureMeta, partial, warnings });
        }
        return;
      }
      if (status === 'failed' || status === 'timeout' || status === 'cancelled') {
        failRun({
          writer,
          projectId,
          userId: user.id,
          runId,
          phase: 'export',
          code: 'EXPORT_FAILED',
          message: row.error_msg || '导出失败',
          recoverableFrom: 'export',
          exportTaskId,
        });
        return;
      }
      await sleep(1500);
    }

    failRun({
      writer,
      projectId,
      userId: user.id,
      runId,
      phase: 'export',
      code: 'EXPORT_TIMEOUT',
      message: '导出超时，请稍后重试',
      recoverableFrom: 'export',
      exportTaskId,
    });
  });
}
