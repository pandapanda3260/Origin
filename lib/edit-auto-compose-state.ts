import { createHash, randomUUID } from 'node:crypto';

export type AutoComposePhase = 'preflight' | 'analyze' | 'edl' | 'export';
export type AutoComposeStatus = 'running' | 'completed' | 'failed' | 'partial';
export type RecoverableFrom = 'analyze' | 'edl' | 'export';

export const COMPOSE_RUN_HISTORY_LIMIT = 20;
export const EDL_HISTORY_LIMIT = 3;
export const RUNNING_STALE_MS = 10 * 60 * 1000;

export type UsableEditSegment = {
  groupIdx: number;
  videoUrl: string;
  videoDurationSec: number;
  videoIsCurrent: boolean;
  taskIsCurrent: boolean;
  scriptHash?: string;
  videoPromptHash?: string;
  shotIndicesHash?: string;
  dialogueHash?: string;
  visualHash?: string;
  charactersHash?: string;
  duration?: number;
};

export type RejectedEditSegment = {
  groupIdx: number;
  reason: string;
};

export type ComposeRun = {
  runId: string;
  status: AutoComposeStatus;
  phase: AutoComposePhase;
  recoverableFrom?: RecoverableFrom;
  heartbeatAt?: string;
  partial: boolean;
  skippedReasons: RejectedEditSegment[];
  segmentFingerprint: string;
  edlVersion?: number;
  exportTaskId?: string;
  exportUrl?: string;
  warnings: any[];
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

function nowMs() {
  return Date.now();
}

export function nowIso() {
  return new Date().toISOString();
}

export function stableStringify(value: any): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256Stable(value: any) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function recoverableFromPhase(phase: any): RecoverableFrom {
  if (phase === 'export') return 'export';
  if (phase === 'edl') return 'edl';
  return 'analyze';
}

export function computeSegmentFingerprint(segments: UsableEditSegment[]) {
  const source = (Array.isArray(segments) ? segments : [])
    .map((s) => ({
      groupIdx: Number(s.groupIdx),
      videoUrl: String(s.videoUrl || ''),
      videoDurationSec: Number(s.videoDurationSec) || 0,
      videoIsCurrent: s.videoIsCurrent !== false,
      taskIsCurrent: s.taskIsCurrent !== false,
      scriptHash: String(s.scriptHash || ''),
      videoPromptHash: String(s.videoPromptHash || ''),
      shotIndicesHash: String(s.shotIndicesHash || ''),
      dialogueHash: String(s.dialogueHash || ''),
      visualHash: String(s.visualHash || ''),
      charactersHash: String(s.charactersHash || ''),
    }))
    .sort((a, b) => a.groupIdx - b.groupIdx);
  return sha256Stable(source);
}

export function collectEditSegmentsForCompose(project: any): {
  usableSegments: UsableEditSegment[];
  skippedSegments: RejectedEditSegment[];
  staleSegments: RejectedEditSegment[];
} {
  const sbs: any[] = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots: any[] = Array.isArray(project?.shots) ? project.shots : [];
  const videoTasks: any[] = Array.isArray(project?.videoTasks) ? project.videoTasks : [];
  const scriptHash = sha256Stable(String(project?.script || project?.scriptDraft || ''));
  const usableSegments: UsableEditSegment[] = [];
  const skippedSegments: RejectedEditSegment[] = [];
  const staleSegments: RejectedEditSegment[] = [];

  for (let groupIdx = 0; groupIdx < sbs.length; groupIdx += 1) {
    const sb = sbs[groupIdx];
    if (!sb) {
      skippedSegments.push({ groupIdx, reason: 'missing_storyboard' });
      continue;
    }
    if (!sb.videoUrl) {
      skippedSegments.push({ groupIdx, reason: 'missing_video_url' });
      continue;
    }
    const vt = videoTasks[groupIdx] || {};
    if (sb.videoIsCurrent === false) {
      staleSegments.push({ groupIdx, reason: 'storyboard_video_stale' });
      continue;
    }
    if (vt && vt.isCurrent === false) {
      staleSegments.push({ groupIdx, reason: 'video_task_stale' });
      continue;
    }
    const duration = Number(
      sb.videoDurationSec ??
      sb.durationSec ??
      sb.duration ??
      vt.durationSec ??
      vt.duration_sec ??
      vt.duration ??
      0,
    );
    if (!Number.isFinite(duration) || duration <= 0) {
      skippedSegments.push({ groupIdx, reason: 'missing_duration' });
      continue;
    }
    const shotIndices: number[] = Array.isArray(sb.shotIndices) && sb.shotIndices.length
      ? sb.shotIndices.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n))
      : [groupIdx];
    const shotsForSeg = shotIndices.map((idx) => shots[idx]).filter(Boolean);
    const dialogues = shotsForSeg.map((shot: any) => String(shot?.dialogue || '').trim());
    const visuals = shotsForSeg.map((shot: any) => String(shot?.visual || shot?.description || '').trim());
    const characters = shotsForSeg.map((shot: any) => (
      Array.isArray(shot?.characters) ? shot.characters.map(String).filter(Boolean) : []
    ));

    usableSegments.push({
      groupIdx,
      videoUrl: String(sb.videoUrl),
      videoDurationSec: duration,
      duration,
      videoIsCurrent: sb.videoIsCurrent !== false,
      taskIsCurrent: vt?.isCurrent !== false,
      scriptHash,
      videoPromptHash: sha256Stable(String(sb.videoPrompt || '')),
      shotIndicesHash: sha256Stable(shotIndices),
      dialogueHash: sha256Stable(dialogues),
      visualHash: sha256Stable(visuals),
      charactersHash: sha256Stable(characters),
    });
  }

  return { usableSegments, skippedSegments, staleSegments };
}

export function cleanStaleRunningComposeRuns(editData: any, maxAgeMs = RUNNING_STALE_MS) {
  const next = { ...(editData || {}) };
  const runs: ComposeRun[] = Array.isArray(next.composeRuns) ? next.composeRuns.map((r: any) => ({ ...r })) : [];
  const now = nowMs();
  let changed = false;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run?.status !== 'running') continue;
    const heartbeat = Date.parse(String(run.heartbeatAt || run.updatedAt || run.createdAt || ''));
    const age = Number.isFinite(heartbeat) ? now - heartbeat : maxAgeMs + 1;
    if (age <= maxAgeMs) continue;
    runs[i] = {
      ...run,
      status: 'failed',
      recoverableFrom: run.recoverableFrom || recoverableFromPhase(run.phase),
      errorCode: run.errorCode || 'STALE_RUNNING_CLEANED',
      errorMessage: run.errorMessage || '上一次一键成片已超时中断，可从失败阶段重试',
      updatedAt: nowIso(),
    };
    changed = true;
  }
  if (changed) next.composeRuns = pruneComposeRuns(runs);
  return { editData: next, changed };
}

export function hasActiveComposeRun(editData: any) {
  const runs = Array.isArray(editData?.composeRuns) ? editData.composeRuns : [];
  return runs.some((r: any) => r?.status === 'running');
}

export function pruneComposeRuns(runs: any[]) {
  return (Array.isArray(runs) ? runs : [])
    .filter(Boolean)
    .slice(-COMPOSE_RUN_HISTORY_LIMIT);
}

export function createComposeRun(args: {
  segmentFingerprint: string;
  partial: boolean;
  skippedReasons: RejectedEditSegment[];
}) {
  const ts = nowIso();
  return {
    runId: randomUUID(),
    status: 'running' as AutoComposeStatus,
    phase: 'preflight' as AutoComposePhase,
    heartbeatAt: ts,
    partial: args.partial,
    skippedReasons: args.skippedReasons,
    segmentFingerprint: args.segmentFingerprint,
    warnings: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

export function upsertComposeRun(editData: any, run: ComposeRun) {
  const next = { ...(editData || {}) };
  const runs: ComposeRun[] = Array.isArray(next.composeRuns) ? next.composeRuns.map((r: any) => ({ ...r })) : [];
  const idx = runs.findIndex((r) => r?.runId === run.runId);
  if (idx >= 0) runs[idx] = run;
  else runs.push(run);
  next.composeRuns = pruneComposeRuns(runs);
  return next;
}

export function updateComposeRun(editData: any, runId: string, patch: Partial<ComposeRun>) {
  const next = { ...(editData || {}) };
  const runs: ComposeRun[] = Array.isArray(next.composeRuns) ? next.composeRuns.map((r: any) => ({ ...r })) : [];
  const idx = runs.findIndex((r) => r?.runId === runId);
  if (idx < 0) return { editData: next, run: null as ComposeRun | null };
  const ts = nowIso();
  const run = {
    ...runs[idx],
    ...patch,
    heartbeatAt: patch.status === 'running' ? ts : (patch.heartbeatAt ?? runs[idx].heartbeatAt),
    updatedAt: ts,
  } as ComposeRun;
  runs[idx] = run;
  next.composeRuns = pruneComposeRuns(runs);
  return { editData: next, run };
}

export function compactEdlForHistory(edl: any) {
  if (!edl || typeof edl !== 'object') return null;
  const compact: any = {
    timeline: Array.isArray(edl.timeline) ? edl.timeline : [],
    bgm: edl.bgm || null,
    version: Number(edl.version) || 0,
    duration: Number(edl.duration) || 0,
    narrative: typeof edl.narrative === 'string' ? edl.narrative : '',
    pacingPlan: typeof edl.pacingPlan === 'string' ? edl.pacingPlan : '',
  };
  for (const key of ['subtitles', 'captions', 'subtitleOverrides']) {
    if (Object.prototype.hasOwnProperty.call(edl, key)) compact[key] = edl[key];
  }
  for (const key of Object.keys(edl)) {
    if (Object.prototype.hasOwnProperty.call(compact, key)) continue;
    if (key.startsWith('_')) continue;
    if (key.toLowerCase().startsWith('origin')) continue;
    compact[key] = edl[key];
  }
  return compact;
}

export function pushEdlHistory(editData: any, args: {
  source: 'auto-compose' | 'manual' | 'legacy';
  fingerprint?: string;
  edl?: any;
}) {
  const next = { ...(editData || {}) };
  const edl = args.edl || next.edl;
  const compact = compactEdlForHistory(edl);
  if (!compact || !Array.isArray(compact.timeline) || !compact.timeline.length) return next;

  const version = Number(compact.version) || 0;
  const existing = Array.isArray(next.edlHistory) ? next.edlHistory : [];
  const withoutDuplicate = existing.filter((item: any) => (
    !(Number(item?.version) === version && item?.source === args.source)
  ));
  next.edlHistory = [
    ...withoutDuplicate,
    {
      version,
      ts: nowIso(),
      source: args.source,
      fingerprint: args.fingerprint || '',
      edl: compact,
    },
  ].slice(-EDL_HISTORY_LIMIT);
  return next;
}
