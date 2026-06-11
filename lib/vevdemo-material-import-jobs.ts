import { createHash, randomUUID } from 'node:crypto';

export type VevDemoMaterialImportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface VevDemoMaterialImportJob<T = any> {
  id: string;
  key: string;
  ownerId: number;
  status: VevDemoMaterialImportJobStatus;
  resourceCount: number;
  bgmCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: T;
  promise?: Promise<void>;
}

type JobState = {
  jobsById: Map<string, VevDemoMaterialImportJob>;
  jobIdByKey: Map<string, string>;
};

const JOB_TTL_MS = 24 * 60 * 60 * 1000;

function globalState(): JobState {
  const g = globalThis as any;
  if (!g.__originVevDemoMaterialImportJobs) {
    g.__originVevDemoMaterialImportJobs = {
      jobsById: new Map<string, VevDemoMaterialImportJob>(),
      jobIdByKey: new Map<string, string>(),
    } satisfies JobState;
  }
  return g.__originVevDemoMaterialImportJobs;
}

function nowIso() {
  return new Date().toISOString();
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
  )).join(',')}}`;
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean))).sort();
}

export function buildVevDemoMaterialImportJobKey(input: {
  ownerId: number;
  projectId?: string | null;
  resourceIds?: unknown;
  bgmTrackIds?: unknown;
  autoRegister?: unknown;
  forceRegister?: unknown;
}) {
  const payload = {
    version: 1,
    ownerId: Number(input.ownerId) || 0,
    projectId: String(input.projectId || '').trim(),
    resourceIds: cleanList(input.resourceIds),
    bgmTrackIds: cleanList(input.bgmTrackIds),
    autoRegister: input.autoRegister !== false,
    forceRegister: input.forceRegister === true,
  };
  return `vevdemo-material-import:${createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

function isTerminal(status: VevDemoMaterialImportJobStatus) {
  return status === 'completed' || status === 'failed';
}

function cleanupOldJobs() {
  const state = globalState();
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of state.jobsById.entries()) {
    if (!isTerminal(job.status)) continue;
    const updatedMs = Date.parse(job.updatedAt || job.completedAt || job.createdAt || '');
    if (Number.isFinite(updatedMs) && updatedMs >= cutoff) continue;
    state.jobsById.delete(id);
    if (state.jobIdByKey.get(job.key) === id) state.jobIdByKey.delete(job.key);
  }
}

export function getVevDemoMaterialImportJob(jobId: string) {
  cleanupOldJobs();
  return globalState().jobsById.get(String(jobId || '').trim()) || null;
}

export function getOrStartVevDemoMaterialImportJob<T>(opts: {
  key: string;
  ownerId: number;
  resourceCount: number;
  bgmCount: number;
  forceNew?: boolean;
  run: () => Promise<T>;
}) {
  cleanupOldJobs();
  const state = globalState();
  const key = String(opts.key || '').trim();
  if (!opts.forceNew) {
    const existingId = state.jobIdByKey.get(key);
    const existing = existingId ? state.jobsById.get(existingId) : null;
    if (existing && existing.ownerId === opts.ownerId && existing.status !== 'failed') {
      return { job: existing as VevDemoMaterialImportJob<T>, reused: true };
    }
  }

  const at = nowIso();
  const job: VevDemoMaterialImportJob<T> = {
    id: randomUUID(),
    key,
    ownerId: Number(opts.ownerId) || 0,
    status: 'queued',
    resourceCount: Math.max(0, Math.floor(Number(opts.resourceCount) || 0)),
    bgmCount: Math.max(0, Math.floor(Number(opts.bgmCount) || 0)),
    createdAt: at,
    updatedAt: at,
  };
  state.jobsById.set(job.id, job);
  state.jobIdByKey.set(key, job.id);

  job.promise = (async () => {
    job.status = 'running';
    job.startedAt = nowIso();
    job.updatedAt = job.startedAt;
    try {
      job.result = await opts.run();
      job.status = 'completed';
      job.completedAt = nowIso();
      job.updatedAt = job.completedAt;
    } catch (error: any) {
      job.status = 'failed';
      job.error = error?.message || String(error || 'unknown error');
      job.completedAt = nowIso();
      job.updatedAt = job.completedAt;
      console.warn(`[vevdemo-material-import] job failed id=${job.id}: ${job.error}`);
    }
  })();

  job.promise.catch(() => undefined);
  return { job, reused: false };
}

export function serializeVevDemoMaterialImportJob(job: VevDemoMaterialImportJob | null) {
  if (!job) return null;
  return {
    async: true,
    jobId: job.id,
    status: job.status,
    done: isTerminal(job.status),
    resourceCount: job.resourceCount,
    bgmCount: job.bgmCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    error: job.error || '',
    result: job.status === 'completed' ? job.result || null : null,
  };
}
