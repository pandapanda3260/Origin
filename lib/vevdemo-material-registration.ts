import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db';
import { getExternalEnvValue, loadExternalEnv } from './env';
import { dataPath } from './runtime-paths';
import { readVevDemoApiUrl } from './vevdemo-config';
import {
  getVevDemoMaterialBinding,
  saveVevDemoMaterialBinding,
  type VevDemoMaterialBinding,
} from './vevdemo-material-bindings';
import { ensureVevDemoProjectBinding } from './vevdemo-project-registration';

const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;

type RegisterVideoTaskOptions = {
  videoTaskId: string;
  ownerId: number;
  forceUpload?: boolean;
  timeoutMs?: number;
  pollMs?: number;
};

type VideoTaskRow = {
  id: string;
  owner_id: number;
  project_id?: string | null;
  group_idx?: number | null;
  prompt?: string | null;
  filename?: string | null;
  duration_sec?: number | null;
};

type PlaySummary = {
  mainPlayUrl: string;
  backupPlayUrl: string;
  codecs: string[];
  playable: boolean;
  h264: boolean;
  fileType: string;
  duration: unknown;
  rawStatus: unknown;
};

type EditMaterialResult = {
  editMid: string;
  reused: boolean;
  raw: unknown;
};

export type VevDemoRegistrationResult = {
  ok: true;
  binding: VevDemoMaterialBinding;
  reusedBinding: boolean;
  reusedEditMaterial: boolean;
  uploaded: boolean;
};

const registrationLocks = new Map<string, Promise<VevDemoRegistrationResult>>();

function envValue(key: string): string {
  return (getExternalEnvValue(key) || process.env[key] || '').trim();
}

function getRequiredEnv(key: string): string {
  const value = envValue(key);
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

function get(obj: any, pathExpr: string): any {
  return pathExpr.split('.').reduce((cur, key) => (cur && cur[key] !== undefined ? cur[key] : undefined), obj);
}

function apiError(data: any): any {
  return get(data, 'ResponseMetadata.Error') || null;
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

function createVodService(): any {
  const { vodOpenapi } = loadOpenapi();
  const service = vodOpenapi.defaultService;
  service.setAccessKeyId(getRequiredEnv('VOLC_ACCESS_KEY'));
  service.setSecretKey(getRequiredEnv('VOLC_SECRET_KEY'));
  service.setRegion(envValue('VITE_VEV_REGION') || 'cn-north-1');
  return service;
}

function buildUploadFunctions({ title, workflowTemplateId }: { title: string; workflowTemplateId: string }) {
  const functions: Array<Record<string, unknown>> = [
    { Name: 'GetMeta' },
    {
      Name: 'AddOptionInfo',
      Input: {
        Title: title,
        Category: 'video',
        FileType: 'media',
        Format: 'mp4',
      },
    },
  ];
  if (workflowTemplateId) {
    functions.push({
      Name: 'StartWorkflow',
      Input: { TemplateId: workflowTemplateId },
    });
  }
  return functions;
}

function summarizePlayInfo(data: any): PlaySummary {
  const playInfoList = get(data, 'Result.PlayInfoList') || [];
  const detailInfo = get(data, 'Result.VideoDetail.VideoDetailInfo') || {};
  const detailPlayInfo = detailInfo.PlayInfo || {};
  const rootFileType = get(data, 'Result.FileType') || detailInfo.FileType || '';
  const mainPlayUrl =
    detailPlayInfo.MainPlayUrl ||
    playInfoList.find((item: any) => item.MainPlayUrl)?.MainPlayUrl ||
    '';
  const backupPlayUrl =
    detailPlayInfo.BackupPlayUrl ||
    playInfoList.find((item: any) => item.BackupPlayUrl)?.BackupPlayUrl ||
    '';
  const codecs = [
    detailInfo.Codec,
    ...playInfoList.map((item: any) => item.Codec),
  ].filter(Boolean).map((item) => String(item).toLowerCase());
  return {
    mainPlayUrl,
    backupPlayUrl,
    codecs,
    playable: Boolean(mainPlayUrl || backupPlayUrl),
    h264: codecs.includes('h264'),
    fileType: rootFileType,
    duration: get(data, 'Result.Duration') ?? detailInfo.Duration ?? null,
    rawStatus: get(data, 'Result.Status') ?? get(data, 'Result.VideoDetail.VideoDetailInfo.PlayInfo.Status') ?? null,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPlayable(service: any, vid: string, timeoutMs: number, pollMs: number): Promise<PlaySummary> {
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < timeoutMs) {
    const data = await service.GetPlayInfo({ Vid: vid });
    const error = apiError(data);
    if (error) {
      last = { error };
    } else {
      const summary = summarizePlayInfo(data);
      last = { summary };
      if (summary.playable && summary.h264) return summary;
      if (
        Date.now() - started > 90 * 1000 &&
        String(summary.fileType || '').toLowerCase() === 'audio' &&
        Number(summary.duration || 0) === 0
      ) {
        throw new Error(`VOD classified uploaded MP4 as empty audio for vid=${vid}; check UploadMedia FileName/FileExtension parameters`);
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for playable H.264 URL for vid=${vid}; last=${JSON.stringify(last).slice(0, 500)}`);
}

async function postJson(apiBase: string, pathname: string, body: unknown): Promise<any> {
  const res = await fetch(`${apiBase.replace(/\/+$/, '')}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${JSON.stringify(data).slice(0, 300)}`);
  const error = apiError(data) || (data && data.code === 1 ? { Code: 'vevdemo_error', Message: data.message } : null);
  if (error) throw new Error(`${pathname} failed: ${error.Code || ''} ${error.Message || ''}`.trim());
  return data;
}

function extractMaterials(searchResult: any): any[] {
  const result = searchResult.Result || {};
  if (Array.isArray(result.Detail)) return result.Detail;
  if (Array.isArray(result.MaterialInfoList)) return result.MaterialInfoList;
  if (Array.isArray(result.EditMaterialList)) return result.EditMaterialList;
  if (Array.isArray(result.MaterialList)) return result.MaterialList;
  if (Array.isArray(result)) return result;
  return [];
}

async function createOrReuseEditMaterial({
  apiBase,
  projectId,
  space,
  title,
  vevSource,
}: {
  apiBase: string;
  projectId: string;
  space: string;
  title: string;
  vevSource: string;
}): Promise<EditMaterialResult> {
  async function findBySource() {
    const search = await postJson(apiBase, '/api/searchEditMaterial', { ProjectId: projectId, Space: space });
    return extractMaterials(search).find((item) => String(item.Source || '') === vevSource);
  }

  const existing = await findBySource();
  if (existing) {
    return {
      editMid: existing.EditMid || existing.editMid || existing.MaterialId || existing.Id || '',
      reused: true,
      raw: existing,
    };
  }

  const created = await postJson(apiBase, '/api/createEditMaterial', {
    ProjectId: projectId,
    Space: space,
    Name: title,
    Type: 'video',
    Source: vevSource,
  });
  const createdEditMid =
    get(created, 'Result.EditMid') ||
    get(created, 'Result.MaterialId') ||
    get(created, 'Result.Id') ||
    '';
  if (createdEditMid) return { editMid: createdEditMid, reused: false, raw: created };

  const createdMaterial = await findBySource();
  if (createdMaterial) {
    return {
      editMid: createdMaterial.EditMid || createdMaterial.editMid || createdMaterial.MaterialId || createdMaterial.Id || '',
      reused: false,
      raw: { create: created, search: createdMaterial },
    };
  }

  return { editMid: '', reused: false, raw: created };
}

async function publishMedia({ apiBase, vid }: { apiBase: string; vid: string }) {
  await postJson(apiBase, '/api/updateMediaPublishStatus', {
    Vid: vid,
    Status: 'Published',
  });
}

function getVideoTask(videoTaskId: string, ownerId: number): VideoTaskRow {
  const row = getDb().prepare(
    `SELECT id, owner_id, project_id, group_idx, prompt, filename, duration_sec
     FROM video_tasks
     WHERE id = ? AND owner_id = ? AND status = 'completed' AND filename IS NOT NULL`,
  ).get(videoTaskId, ownerId) as VideoTaskRow | undefined;
  if (!row) throw new Error(`video_task not found or not completed: ${videoTaskId}`);
  return row;
}

async function registerVideoTaskMaterial(options: RegisterVideoTaskOptions): Promise<VevDemoRegistrationResult> {
  loadExternalEnv();

  const row = getVideoTask(options.videoTaskId, options.ownerId);
  const projectBinding = row.project_id
    ? await ensureVevDemoProjectBinding(row.project_id, options.ownerId)
    : null;
  const projectId = projectBinding?.vevProjectId || getRequiredEnv('VITE_VEV_PROJECT_ID');
  const groupId = projectBinding?.vevGroupId || getRequiredEnv('VITE_VEV_GROUP_ID');
  const space = projectBinding?.vevSpace || envValue('VITE_VEV_SPACE') || 'origin';
  const existing = getVevDemoMaterialBinding('video_task', options.videoTaskId, projectId);
  const reusableSourceBinding = existing || getVevDemoMaterialBinding('video_task', options.videoTaskId);
  if (
    existing?.vevSource &&
    existing.vevEditMid &&
    !options.forceUpload
  ) {
    return {
      ok: true,
      binding: existing,
      reusedBinding: true,
      reusedEditMaterial: true,
      uploaded: false,
    };
  }

  const sourcePath = dataPath('videos', String(row.owner_id), String(row.filename));
  if (!existsSync(sourcePath)) throw new Error(`Missing video file: ${sourcePath}`);

  const apiBase = envValue('VITE_VEVDEMO_API_BASE') || readVevDemoApiUrl() || 'http://127.0.0.1:3002';
  const workflowTemplateId = envValue('VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID');
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs || DEFAULT_POLL_MS;
  const title = `origin-${row.id}.mp4`;

  let uploaded = false;
  let vid = existing?.vid || reusableSourceBinding?.vid || '';
  let vevSource = existing?.vevSource || reusableSourceBinding?.vevSource || '';
  let playSummary: PlaySummary | null = null;
  const service = createVodService();
  if (vid && vevSource && reusableSourceBinding?.playInfo?.h264 && !options.forceUpload) {
    playSummary = {
      mainPlayUrl: reusableSourceBinding.playInfo?.mainPlayUrl ? 'present' : '',
      backupPlayUrl: reusableSourceBinding.playInfo?.backupPlayUrl ? 'present' : '',
      codecs: reusableSourceBinding.playInfo?.codecs || ['h264'],
      playable: true,
      h264: true,
      fileType: 'media',
      duration: null,
      rawStatus: null,
    };
  } else {
    const uploadRes = await service.UploadMedia({
      SpaceName: space,
      FilePath: sourcePath,
      FileExtension: '.mp4',
      Functions: JSON.stringify(buildUploadFunctions({ title, workflowTemplateId })),
    });
    const uploadError = apiError(uploadRes);
    if (uploadError) throw new Error(`UploadMedia failed: ${uploadError.Code || ''} ${uploadError.Message || ''}`.trim());
    vid = get(uploadRes, 'Result.Data.Vid');
    if (!vid) throw new Error(`UploadMedia did not return Vid: ${JSON.stringify(uploadRes).slice(0, 500)}`);
    uploaded = true;
    await publishMedia({ apiBase, vid });
    playSummary = await waitForPlayable(service, vid, timeoutMs, pollMs);
    vevSource = `vid://${vid}`;
  }
  const editMaterial = await createOrReuseEditMaterial({
    apiBase,
    projectId,
    space,
    title,
    vevSource,
  });
  if (!editMaterial.editMid) {
    throw new Error(`CreateEditMaterial succeeded but no EditMid was found for Source=${vevSource}`);
  }

  const binding: VevDemoMaterialBinding = {
    resourceType: 'video_task',
    resourceId: row.id,
    originProjectId: row.project_id || null,
    ownerId: Number(row.owner_id),
    originFilePath: sourcePath,
    title,
    vid,
    vevSource,
    vevProjectId: projectId,
    vevGroupId: groupId,
    vevSpace: space,
    vevEditMid: editMaterial.editMid,
    uploadedAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    uploadWorkflowTemplateId: workflowTemplateId || null,
    playInfo: {
      mainPlayUrl: playSummary?.mainPlayUrl ? 'present' : '',
      backupPlayUrl: playSummary?.backupPlayUrl ? 'present' : '',
      codecs: playSummary?.codecs || [],
      h264: Boolean(playSummary?.h264),
    },
  };
  saveVevDemoMaterialBinding(binding);

  return {
    ok: true,
    binding,
    reusedBinding: false,
    reusedEditMaterial: editMaterial.reused,
    uploaded,
  };
}

export function ensureVevDemoBindingForVideoTask(options: RegisterVideoTaskOptions): Promise<VevDemoRegistrationResult> {
  const lockKey = `video_task:${options.videoTaskId}`;
  const existingLock = registrationLocks.get(lockKey);
  if (existingLock && !options.forceUpload) return existingLock;

  const promise = registerVideoTaskMaterial(options)
    .finally(() => {
      if (registrationLocks.get(lockKey) === promise) registrationLocks.delete(lockKey);
    });
  registrationLocks.set(lockKey, promise);
  return promise;
}
