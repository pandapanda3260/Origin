import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
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
import { buildVideoSegmentNamesForRow } from './video-segment-names';

const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;

type RegisterVideoTaskOptions = {
  videoTaskId: string;
  ownerId: number;
  forceUpload?: boolean;
  timeoutMs?: number;
  pollMs?: number;
};

type RegisterBgmTrackOptions = {
  bgmTrackId: string;
  ownerId: number;
  originProjectId?: string | null;
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
  project_title?: string | null;
  project_data_json?: string | null;
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

function buildUploadFunctions({
  title,
  workflowTemplateId,
  category = 'video',
  format = 'mp4',
}: {
  title: string;
  workflowTemplateId: string;
  category?: 'video' | 'audio';
  format?: string;
}) {
  const functions: Array<Record<string, unknown>> = [
    { Name: 'GetMeta' },
    {
      Name: 'AddOptionInfo',
      Input: {
        Title: title,
        Category: category,
        FileType: 'media',
        Format: format,
      },
    },
  ];
  if (category === 'video' && workflowTemplateId) {
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

async function waitForPlayable(
  service: any,
  vid: string,
  timeoutMs: number,
  pollMs: number,
  options: { requireH264?: boolean } = {},
): Promise<PlaySummary> {
  const started = Date.now();
  let last: unknown = null;
  const requireH264 = options.requireH264 !== false;
  while (Date.now() - started < timeoutMs) {
    const data = await service.GetPlayInfo({ Vid: vid });
    const error = apiError(data);
    if (error) {
      last = { error };
    } else {
      const summary = summarizePlayInfo(data);
      last = { summary };
      if (summary.playable && (!requireH264 || summary.h264)) return summary;
      if (
        requireH264 &&
        Date.now() - started > 90 * 1000 &&
        String(summary.fileType || '').toLowerCase() === 'audio' &&
        Number(summary.duration || 0) === 0
      ) {
        throw new Error(`VOD classified uploaded MP4 as empty audio for vid=${vid}; check UploadMedia FileName/FileExtension parameters`);
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for playable ${requireH264 ? 'H.264 ' : ''}URL for vid=${vid}; last=${JSON.stringify(last).slice(0, 500)}`);
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
  materialType = 'video',
}: {
  apiBase: string;
  projectId: string;
  space: string;
  title: string;
  vevSource: string;
  materialType?: 'video' | 'audio';
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
    Type: materialType,
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
	    `SELECT vt.id, vt.owner_id, vt.project_id, vt.group_idx, vt.prompt, vt.filename, vt.duration_sec,
	            p.title AS project_title, p.data_json AS project_data_json
	       FROM video_tasks vt
	       LEFT JOIN projects p ON p.id = vt.project_id AND p.owner_id = vt.owner_id
	      WHERE vt.id = ? AND vt.owner_id = ? AND vt.status = 'completed' AND vt.filename IS NOT NULL`,
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
	  const names = buildVideoSegmentNamesForRow(row);
	  const title = names.downloadFilename;

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
      Functions: JSON.stringify(buildUploadFunctions({ title, workflowTemplateId, category: 'video', format: 'mp4' })),
    });
    const uploadError = apiError(uploadRes);
    if (uploadError) throw new Error(`UploadMedia failed: ${uploadError.Code || ''} ${uploadError.Message || ''}`.trim());
    vid = get(uploadRes, 'Result.Data.Vid');
    if (!vid) throw new Error(`UploadMedia did not return Vid: ${JSON.stringify(uploadRes).slice(0, 500)}`);
    uploaded = true;
    await publishMedia({ apiBase, vid });
    playSummary = await waitForPlayable(service, vid, timeoutMs, pollMs, { requireH264: true });
    vevSource = `vid://${vid}`;
  }
  const editMaterial = await createOrReuseEditMaterial({
    apiBase,
    projectId,
    space,
    title,
    vevSource,
    materialType: 'video',
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

function assertSafeBgmTrackId(trackId: string): string {
  const value = String(trackId || '').trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid BGM track id: ${trackId}`);
  }
  if (!/\.(mp3|wav|m4a|aac|ogg)$/i.test(value)) {
    throw new Error(`Unsupported BGM audio extension: ${trackId}`);
  }
  return value;
}

function readBgmTitle(trackId: string): string {
  try {
    const metaPath = dataPath('bgm', '_meta.json');
    if (!existsSync(metaPath)) return trackId.replace(/\.[^.]+$/, '');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8') || '{}');
    const entry = meta && typeof meta === 'object' ? meta[trackId] : null;
    return String(entry?.name || trackId.replace(/\.[^.]+$/, '')).trim();
  } catch {
    return trackId.replace(/\.[^.]+$/, '');
  }
}

async function registerBgmTrackMaterial(options: RegisterBgmTrackOptions): Promise<VevDemoRegistrationResult> {
  loadExternalEnv();

  const trackId = assertSafeBgmTrackId(options.bgmTrackId);
  const sourcePath = dataPath('bgm', trackId);
  if (!existsSync(sourcePath)) throw new Error(`Missing BGM file: ${sourcePath}`);

  const projectBinding = options.originProjectId
    ? await ensureVevDemoProjectBinding(options.originProjectId, options.ownerId)
    : null;
  const projectId = projectBinding?.vevProjectId || getRequiredEnv('VITE_VEV_PROJECT_ID');
  const groupId = projectBinding?.vevGroupId || getRequiredEnv('VITE_VEV_GROUP_ID');
  const space = projectBinding?.vevSpace || envValue('VITE_VEV_SPACE') || 'origin';
  const existing = getVevDemoMaterialBinding('bgm', trackId, projectId);
  const reusableSourceBinding = existing || getVevDemoMaterialBinding('bgm', trackId);
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

  const apiBase = envValue('VITE_VEVDEMO_API_BASE') || readVevDemoApiUrl() || 'http://127.0.0.1:3002';
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs || DEFAULT_POLL_MS;
  const ext = extname(trackId).replace(/^\./, '').toLowerCase() || 'mp3';
  const title = `origin-bgm-${readBgmTitle(trackId)}`;

  let uploaded = false;
  let vid = existing?.vid || reusableSourceBinding?.vid || '';
  let vevSource = existing?.vevSource || reusableSourceBinding?.vevSource || '';
  let playSummary: PlaySummary | null = null;
  const service = createVodService();
  if (vid && vevSource && !options.forceUpload) {
    playSummary = {
      mainPlayUrl: reusableSourceBinding?.playInfo?.mainPlayUrl ? 'present' : '',
      backupPlayUrl: reusableSourceBinding?.playInfo?.backupPlayUrl ? 'present' : '',
      codecs: reusableSourceBinding?.playInfo?.codecs || [],
      playable: true,
      h264: false,
      fileType: 'audio',
      duration: null,
      rawStatus: null,
    };
  } else {
    const uploadRes = await service.UploadMedia({
      SpaceName: space,
      FilePath: sourcePath,
      FileExtension: `.${ext}`,
      Functions: JSON.stringify(buildUploadFunctions({
        title,
        workflowTemplateId: '',
        category: 'audio',
        format: ext === 'mpeg' ? 'mp3' : ext,
      })),
    });
    const uploadError = apiError(uploadRes);
    if (uploadError) throw new Error(`UploadMedia BGM failed: ${uploadError.Code || ''} ${uploadError.Message || ''}`.trim());
    vid = get(uploadRes, 'Result.Data.Vid');
    if (!vid) throw new Error(`UploadMedia BGM did not return Vid: ${JSON.stringify(uploadRes).slice(0, 500)}`);
    uploaded = true;
    await publishMedia({ apiBase, vid });
    playSummary = await waitForPlayable(service, vid, timeoutMs, pollMs, { requireH264: false });
    vevSource = `vid://${vid}`;
  }

  const editMaterial = await createOrReuseEditMaterial({
    apiBase,
    projectId,
    space,
    title,
    vevSource,
    materialType: 'audio',
  });
  if (!editMaterial.editMid) {
    throw new Error(`CreateEditMaterial succeeded but no audio EditMid was found for Source=${vevSource}`);
  }

  const binding: VevDemoMaterialBinding = {
    resourceType: 'bgm',
    resourceId: trackId,
    originProjectId: options.originProjectId || null,
    ownerId: Number(options.ownerId),
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
    uploadWorkflowTemplateId: null,
    playInfo: {
      mainPlayUrl: playSummary?.mainPlayUrl ? 'present' : '',
      backupPlayUrl: playSummary?.backupPlayUrl ? 'present' : '',
      codecs: playSummary?.codecs || [],
      h264: false,
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

type RegisterUploadOptions = {
  uploadId: string;
  ownerId: number;
  originProjectId?: string | null;
  forceUpload?: boolean;
  timeoutMs?: number;
  pollMs?: number;
};

type UploadRow = {
  id: string;
  owner_id: number;
  project_id?: string | null;
  kind?: string | null;
  filename?: string | null;
  mime?: string | null;
  duration_sec?: number | null;
};

const UPLOAD_AUDIO_EXT_RE = /^(mp3|wav|m4a|aac|ogg|flac)$/;
const UPLOAD_IMAGE_EXT_RE = /^(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/;

function getUpload(uploadId: string, ownerId: number): UploadRow {
  const row = getDb().prepare(
    `SELECT id, owner_id, project_id, kind, filename, mime, duration_sec
     FROM uploads
     WHERE id = ? AND owner_id = ? AND filename IS NOT NULL`,
  ).get(uploadId, ownerId) as UploadRow | undefined;
  if (!row) throw new Error(`upload not found: ${uploadId}`);
  return row;
}

/**
 * 上传素材分类。图片不进 VOD 剪辑时间线（与时间线只支持视频/图片暂拦截的口径一致），
 * 直接抛出可识别错误，让调用方降级为 unsupported。
 */
function classifyUpload(row: UploadRow): { category: 'video' | 'audio'; ext: string } {
  const ext = extname(String(row.filename || '')).replace(/^\./, '').toLowerCase() || 'mp4';
  if (String(row.kind) === 'image' || UPLOAD_IMAGE_EXT_RE.test(ext)) {
    throw new Error('image_upload_not_supported_for_vevdemo_timeline');
  }
  const category: 'video' | 'audio' =
    String(row.kind) === 'audio' || UPLOAD_AUDIO_EXT_RE.test(ext) ? 'audio' : 'video';
  return { category, ext };
}

/**
 * 把本地上传素材注册到火山 VOD + VevDemo（与 video_task 同一套上传/转码/createEditMaterial 流程）。
 * 注册成功后 binding.vevSource = vid://...，VevDemo 走云端播放，绕开 Origin 直链需登录态的限制。
 */
async function registerUploadMaterial(options: RegisterUploadOptions): Promise<VevDemoRegistrationResult> {
  loadExternalEnv();

  const row = getUpload(options.uploadId, options.ownerId);
  const { category, ext } = classifyUpload(row);

  const originProjectId = options.originProjectId || row.project_id || null;
  const projectBinding = originProjectId
    ? await ensureVevDemoProjectBinding(originProjectId, options.ownerId)
    : null;
  const projectId = projectBinding?.vevProjectId || getRequiredEnv('VITE_VEV_PROJECT_ID');
  const groupId = projectBinding?.vevGroupId || getRequiredEnv('VITE_VEV_GROUP_ID');
  const space = projectBinding?.vevSpace || envValue('VITE_VEV_SPACE') || 'origin';
  const existing = getVevDemoMaterialBinding('upload', options.uploadId, projectId);
  const reusableSourceBinding = existing || getVevDemoMaterialBinding('upload', options.uploadId);
  if (existing?.vevSource && existing.vevEditMid && !options.forceUpload) {
    return {
      ok: true,
      binding: existing,
      reusedBinding: true,
      reusedEditMaterial: true,
      uploaded: false,
    };
  }

  const sourcePath = dataPath('uploads', String(row.owner_id), String(row.filename));
  if (!existsSync(sourcePath)) throw new Error(`Missing upload file: ${sourcePath}`);

  const apiBase = envValue('VITE_VEVDEMO_API_BASE') || readVevDemoApiUrl() || 'http://127.0.0.1:3002';
  const workflowTemplateId = category === 'video' ? envValue('VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID') : '';
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs || DEFAULT_POLL_MS;
  const title = `origin-upload-${row.id}.${ext}`;
  const format = ext === 'mpeg' ? 'mp3' : ext;

  let uploaded = false;
  let vid = existing?.vid || reusableSourceBinding?.vid || '';
  let vevSource = existing?.vevSource || reusableSourceBinding?.vevSource || '';
  let playSummary: PlaySummary | null = null;
  const service = createVodService();
  if (vid && vevSource && !options.forceUpload) {
    playSummary = {
      mainPlayUrl: reusableSourceBinding?.playInfo?.mainPlayUrl ? 'present' : '',
      backupPlayUrl: reusableSourceBinding?.playInfo?.backupPlayUrl ? 'present' : '',
      codecs: reusableSourceBinding?.playInfo?.codecs || [],
      playable: true,
      h264: Boolean(reusableSourceBinding?.playInfo?.h264),
      fileType: category === 'audio' ? 'audio' : 'media',
      duration: null,
      rawStatus: null,
    };
  } else {
    const uploadRes = await service.UploadMedia({
      SpaceName: space,
      FilePath: sourcePath,
      FileExtension: `.${ext}`,
      Functions: JSON.stringify(buildUploadFunctions({ title, workflowTemplateId, category, format })),
    });
    const uploadError = apiError(uploadRes);
    if (uploadError) throw new Error(`UploadMedia upload failed: ${uploadError.Code || ''} ${uploadError.Message || ''}`.trim());
    vid = get(uploadRes, 'Result.Data.Vid');
    if (!vid) throw new Error(`UploadMedia did not return Vid: ${JSON.stringify(uploadRes).slice(0, 500)}`);
    uploaded = true;
    await publishMedia({ apiBase, vid });
    playSummary = await waitForPlayable(service, vid, timeoutMs, pollMs, { requireH264: category === 'video' });
    vevSource = `vid://${vid}`;
  }

  const editMaterial = await createOrReuseEditMaterial({
    apiBase,
    projectId,
    space,
    title,
    vevSource,
    materialType: category,
  });
  if (!editMaterial.editMid) {
    throw new Error(`CreateEditMaterial succeeded but no EditMid was found for Source=${vevSource}`);
  }

  const binding: VevDemoMaterialBinding = {
    resourceType: 'upload',
    resourceId: row.id,
    originProjectId,
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

export function ensureVevDemoBindingForUpload(options: RegisterUploadOptions): Promise<VevDemoRegistrationResult> {
  const lockKey = `upload:${options.uploadId}`;
  const existingLock = registrationLocks.get(lockKey);
  if (existingLock && !options.forceUpload) return existingLock;

  const promise = registerUploadMaterial(options)
    .finally(() => {
      if (registrationLocks.get(lockKey) === promise) registrationLocks.delete(lockKey);
    });
  registrationLocks.set(lockKey, promise);
  return promise;
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

export function ensureVevDemoBindingForBgmTrack(options: RegisterBgmTrackOptions): Promise<VevDemoRegistrationResult> {
  const lockKey = `bgm:${options.originProjectId || 'default'}:${options.bgmTrackId}`;
  const existingLock = registrationLocks.get(lockKey);
  if (existingLock && !options.forceUpload) return existingLock;

  const promise = registerBgmTrackMaterial(options)
    .finally(() => {
      if (registrationLocks.get(lockKey) === promise) registrationLocks.delete(lockKey);
    });
  registrationLocks.set(lockKey, promise);
  return promise;
}
