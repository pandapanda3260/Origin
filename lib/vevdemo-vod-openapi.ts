import { join } from 'node:path';
import { getExternalEnvValue, loadExternalEnv } from './env';

export type VevDemoRemoteTaskState = 'running' | 'completed' | 'failed' | 'unknown';

export type VevDemoRemoteTaskResult = {
  providerTaskId: string;
  state: VevDemoRemoteTaskState;
  outputUrl: string | null;
  outputVid: string | null;
  errorMsg: string | null;
  raw: unknown;
  task: unknown;
};

export class VevDemoVodOpenapiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, details?: unknown, status = 502) {
    super(message);
    this.name = 'VevDemoVodOpenapiError';
    this.status = status;
    this.details = details;
  }
}

function envValue(key: string): string {
  loadExternalEnv();
  return (getExternalEnvValue(key) || process.env[key] || '').trim();
}

function requiredEnv(key: string): string {
  const value = envValue(key);
  if (!value) throw new VevDemoVodOpenapiError(`Missing required env: ${key}`, { key }, 500);
  return value;
}

function loadOpenapi(): any {
  const modulePath = join(
    process.cwd(),
    'vevdemo-1.0.6',
    'nodejs',
    'node_modules',
    '@volcengine',
    'openapi',
  );
  const nodeRequire = eval('require') as NodeRequire;
  return nodeRequire(modulePath);
}

function apiError(data: any): any {
  return data?.ResponseMetadata?.Error || null;
}

async function signedVodRequest(input: {
  action: string;
  method?: 'GET' | 'POST';
  version?: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown> | null;
}) {
  const { Signer } = loadOpenapi();
  const method = input.method || 'GET';
  const region = envValue('VITE_VEV_REGION') || 'cn-north-1';
  const params = {
    Action: input.action,
    Version: input.version || '2018-01-01',
    ...input.params,
  } as Record<string, unknown>;
  const requestData: any = {
    method,
    region,
    params,
    headers: { 'Content-Type': 'application/json' },
  };
  if (method === 'POST') requestData.body = JSON.stringify(input.body || {});
  const signer = new Signer(requestData, 'vod');
  signer.addAuthorization({
    accessKeyId: requiredEnv('VOLC_ACCESS_KEY'),
    secretKey: requiredEnv('VOLC_SECRET_KEY'),
  });
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  const res = await fetch(`https://vod.volcengineapi.com/?${query.toString()}`, {
    method,
    headers: requestData.headers,
    ...(method === 'POST' ? { body: requestData.body } : {}),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new VevDemoVodOpenapiError(`VOD ${input.action} HTTP ${res.status}`, data, 502);
  const error = apiError(data);
  if (error) {
    throw new VevDemoVodOpenapiError(
      `VOD ${input.action} failed: ${error.Code || ''} ${error.Message || ''}`.trim(),
      data,
      502,
    );
  }
  return data;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readAnyString(source: unknown, keys: string[]): string | null {
  if (!isObject(source)) return null;
  for (const key of keys) {
    const value = normalizeText(source[key]);
    if (value) return value;
  }
  return null;
}

function collectObjects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, out));
    return out;
  }
  if (!isObject(value)) return out;
  out.push(value);
  Object.values(value).forEach((item) => collectObjects(item, out));
  return out;
}

function readTaskId(value: unknown): string | null {
  return readAnyString(value, ['TaskId', 'TaskID', 'taskId', 'task_id', 'EditTaskId', 'editTaskId', 'Id', 'ID', 'id']);
}

function findTaskRecord(raw: unknown, providerTaskId: string): unknown {
  const result = isObject(raw) ? raw.Result : undefined;
  const candidates: unknown[] = [];
  if (Array.isArray((result as any)?.TaskList)) candidates.push(...(result as any).TaskList);
  if (Array.isArray((result as any)?.Tasks)) candidates.push(...(result as any).Tasks);
  if (Array.isArray((result as any)?.TaskInfoList)) candidates.push(...(result as any).TaskInfoList);
  if (Array.isArray((result as any)?.TaskSet)) candidates.push(...(result as any).TaskSet);
  if (Array.isArray((result as any)?.Items)) candidates.push(...(result as any).Items);
  if (Array.isArray(result)) candidates.push(...result);
  if (result && isObject(result)) candidates.push(result);
  candidates.push(...collectObjects(result));
  return candidates.find((item) => readTaskId(item) === providerTaskId) || candidates[0] || result || raw;
}

function readRecursiveString(source: unknown, keys: Set<string>): string | null {
  if (Array.isArray(source)) {
    for (const item of source) {
      const value = readRecursiveString(item, keys);
      if (value) return value;
    }
    return null;
  }
  if (!isObject(source)) return null;
  for (const [key, value] of Object.entries(source)) {
    if (keys.has(key.toLowerCase())) {
      const normalized = normalizeText(value);
      if (normalized) return normalized;
    }
  }
  for (const value of Object.values(source)) {
    const nested = readRecursiveString(value, keys);
    if (nested) return nested;
  }
  return null;
}

function readStatusText(task: unknown): string {
  return readAnyString(task, [
    'Status',
    'TaskStatus',
    'State',
    'TaskState',
    'status',
    'taskStatus',
    'state',
    'ProcessStatus',
  ]) || '';
}

function classifyRemoteState(task: unknown, outputUrl: string | null, outputVid: string | null): VevDemoRemoteTaskState {
  if (outputUrl || outputVid) return 'completed';
  const status = readStatusText(task).toLowerCase();
  if (!status) return 'unknown';
  if (/fail|error|cancel|reject|abort|timeout/.test(status)) return 'failed';
  if (/success|succeed|complete|finish|done/.test(status)) return 'completed';
  if (/run|process|queue|wait|submit|start|pending|render|created/.test(status)) return 'running';
  return 'unknown';
}

export function parseVevDemoRemoteTaskResult(raw: unknown, providerTaskId: string): VevDemoRemoteTaskResult {
  const task = findTaskRecord(raw, providerTaskId);
  const outputUrl = readRecursiveString(task, new Set([
    'outputurl',
    'output_url',
    'fileurl',
    'file_url',
    'playurl',
    'play_url',
    'mainplayurl',
    'main_play_url',
    'videourl',
    'video_url',
    'downloadurl',
    'download_url',
    'url',
  ]));
  const outputVid = readRecursiveString(task, new Set([
    'vid',
    'videoid',
    'video_id',
    'outputvid',
    'output_vid',
    'outputvideoid',
    'output_video_id',
  ]));
  const state = classifyRemoteState(task, outputUrl, outputVid);
  const errorMsg = readRecursiveString(task, new Set(['errormsg', 'error_msg', 'message', 'errmsg', 'reason']));
  return {
    providerTaskId,
    state,
    outputUrl,
    outputVid,
    errorMsg: state === 'failed' ? errorMsg || readStatusText(task) || 'remote task failed' : null,
    raw,
    task,
  };
}

export function extractVevDemoPlayUrl(raw: unknown): string | null {
  return readRecursiveString(raw, new Set([
    'mainplayurl',
    'main_play_url',
    'backupplayurl',
    'backup_play_url',
    'playurl',
    'play_url',
    'fileurl',
    'file_url',
    'url',
  ]));
}

export async function getVevDemoVideoPlayUrl(input: {
  vid: string;
  space?: string | null;
}): Promise<{ outputUrl: string | null; raw: unknown }> {
  const params: Record<string, unknown> = { Vid: input.vid };
  if (input.space) params.Space = input.space;
  const raw = await signedVodRequest({
    action: 'GetVideoPlayInfo',
    version: '2018-01-01',
    method: 'GET',
    params,
  });
  return { outputUrl: extractVevDemoPlayUrl(raw), raw };
}

export async function getVevDemoExportTaskResult(input: {
  providerTaskId: string;
  space?: string | null;
}): Promise<VevDemoRemoteTaskResult> {
  const raw = await signedVodRequest({
    action: 'GetTaskList',
    version: '2018-01-01',
    method: 'GET',
    params: { TaskId: input.providerTaskId },
  });
  const parsed = parseVevDemoRemoteTaskResult(raw, input.providerTaskId);
  if (!parsed.outputUrl && parsed.outputVid) {
    const play = await getVevDemoVideoPlayUrl({ vid: parsed.outputVid, space: input.space });
    return {
      ...parsed,
      outputUrl: play.outputUrl,
      raw: { taskList: raw, playInfo: play.raw },
    };
  }
  return parsed;
}
