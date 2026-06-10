#!/usr/bin/env node

/**
 * Phase P0-1a helper:
 *   Origin local video_task MP4 -> VOD Vid -> VevDemo EditMaterial binding.
 *
 * This intentionally writes only data/vevdemo-material-bindings.json. It does
 * not mutate Origin video_tasks/uploads schema and does not print secrets.
 *
 * Prereq: cd vevdemo-1.0.6/nodejs && npm install
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const REPO_ROOT = path.resolve(__dirname, '..');
const VEVDemo_NODE_ROOT = path.join(REPO_ROOT, 'vevdemo-1.0.6', 'nodejs');
const ORIGIN_ENV_FILE = process.env.ORIGIN_ENV_FILE || '/Users/mark/Documents/key/origin.env.local';
const DATA_DIR = path.resolve(process.env.ORIGIN_DATA_DIR || process.env.DATA_DIR || path.join(REPO_ROOT, 'data'));
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'qd.sqlite');
const BINDINGS_PATH = path.join(DATA_DIR, 'vevdemo-material-bindings.json');
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2] || '';
    const commentIndex = value.search(/\s#/);
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function get(obj, pathExpr) {
  return pathExpr.split('.').reduce((cur, key) => (cur && cur[key] !== undefined ? cur[key] : undefined), obj);
}

function apiError(data) {
  return get(data, 'ResponseMetadata.Error') || null;
}

function loadBindings() {
  if (!fs.existsSync(BINDINGS_PATH)) return { version: 1, materials: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(BINDINGS_PATH, 'utf8'));
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      materials: parsed.materials && typeof parsed.materials === 'object' ? parsed.materials : {},
    };
  } catch {
    return { version: 1, materials: {} };
  }
}

function saveBinding(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const bindings = loadBindings();
  bindings.version = 1;
  bindings.materials ||= {};
  const vevProjectId = String(entry.vevProjectId || '').trim();
  const key = vevProjectId
    ? `${entry.resourceType}:${entry.resourceId}:${vevProjectId}`
    : `${entry.resourceType}:${entry.resourceId}`;
  bindings.materials[key] = entry;
  const tmp = `${BINDINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2) + '\n');
  fs.renameSync(tmp, BINDINGS_PATH);
}

function getBinding(bindings, resourceType, resourceId, vevProjectId) {
  const materials = bindings.materials || {};
  const legacyKey = `${resourceType}:${resourceId}`;
  const targetProjectId = String(vevProjectId || '').trim();
  if (targetProjectId) {
    const projectBinding = materials[`${legacyKey}:${targetProjectId}`];
    if (projectBinding?.vevSource) return projectBinding;
    const legacyBinding = materials[legacyKey];
    if (legacyBinding?.vevSource && (!legacyBinding.vevProjectId || legacyBinding.vevProjectId === targetProjectId)) {
      return legacyBinding;
    }
    return Object.values(materials).find((binding) => (
      binding?.vevSource &&
      binding.resourceType === resourceType &&
      binding.resourceId === resourceId &&
      binding.vevProjectId === targetProjectId
    )) || null;
  }
  if (materials[legacyKey]?.vevSource) return materials[legacyKey];
  return Object.values(materials).find((binding) => (
    binding?.vevSource &&
    binding.resourceType === resourceType &&
    binding.resourceId === resourceId
  )) || null;
}

function loadOpenapi() {
  return require(path.join(VEVDemo_NODE_ROOT, 'node_modules', '@volcengine', 'openapi'));
}

function createVodService(env) {
  const { vodOpenapi } = loadOpenapi();
  const service = vodOpenapi.defaultService;
  service.setAccessKeyId(env.VOLC_ACCESS_KEY);
  service.setSecretKey(env.VOLC_SECRET_KEY);
  service.setRegion(env.VITE_VEV_REGION || 'cn-north-1');
  return service;
}

function chooseVideoTask(db, requestedId) {
  if (requestedId) {
    const row = db.prepare(
      "SELECT * FROM video_tasks WHERE id = ? AND status = 'completed' AND filename IS NOT NULL",
    ).get(requestedId);
    if (!row) throw new Error(`video_task not found or not completed: ${requestedId}`);
    return row;
  }
  const row = db.prepare(
    "SELECT * FROM video_tasks WHERE status = 'completed' AND filename IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  ).get();
  if (!row) throw new Error('No completed video_tasks with filename found');
  return row;
}

function buildUploadFunctions({ title, workflowTemplateId }) {
  const functions = [
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

function summarizePlayInfo(data) {
  const playInfoList = get(data, 'Result.PlayInfoList') || [];
  const detailInfo = get(data, 'Result.VideoDetail.VideoDetailInfo') || {};
  const detailPlayInfo = detailInfo.PlayInfo || {};
  const rootFileType = get(data, 'Result.FileType') || detailInfo.FileType || '';
  const mainPlayUrl =
    detailPlayInfo.MainPlayUrl ||
    playInfoList.find((item) => item.MainPlayUrl)?.MainPlayUrl ||
    '';
  const backupPlayUrl =
    detailPlayInfo.BackupPlayUrl ||
    playInfoList.find((item) => item.BackupPlayUrl)?.BackupPlayUrl ||
    '';
  const codecs = [
    detailInfo.Codec,
    ...playInfoList.map((item) => item.Codec),
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

async function waitForPlayable(service, vid, timeoutMs, pollMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const data = await service.GetPlayInfo({ Vid: vid });
    const error = apiError(data);
    if (error) {
      last = { error };
    } else {
      const summary = summarizePlayInfo(data);
      last = { summary };
      if (summary.playable && summary.h264) return { data, summary };
      if (
        Date.now() - started > 90 * 1000 &&
        String(summary.fileType || '').toLowerCase() === 'audio' &&
        Number(summary.duration || 0) === 0
      ) {
        throw new Error(`VOD classified uploaded MP4 as empty audio for vid=${vid}; check UploadMedia FileName/FileExtension parameters`);
      }
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`[register-vevdemo] waiting for playable h264 vid=${vid} elapsed=${elapsed}s`);
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for playable H.264 URL for vid=${vid}; last=${JSON.stringify(last).slice(0, 500)}`);
}

async function postJson(apiBase, pathname, body) {
  const res = await fetch(`${apiBase.replace(/\/+$/, '')}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${JSON.stringify(data).slice(0, 300)}`);
  const error = apiError(data) || (data && data.code === 1 ? { Code: 'vevdemo_error', Message: data.message } : null);
  if (error) throw new Error(`${pathname} failed: ${error.Code || ''} ${error.Message || ''}`.trim());
  return data;
}

function extractMaterials(searchResult) {
  const result = searchResult.Result || {};
  if (Array.isArray(result.Detail)) return result.Detail;
  if (Array.isArray(result.MaterialInfoList)) return result.MaterialInfoList;
  if (Array.isArray(result.EditMaterialList)) return result.EditMaterialList;
  if (Array.isArray(result.MaterialList)) return result.MaterialList;
  if (Array.isArray(result)) return result;
  return [];
}

async function createOrReuseEditMaterial({ apiBase, projectId, space, title, vevSource }) {
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
  const payload = {
    ProjectId: projectId,
    Space: space,
    Name: title,
    Type: 'video',
    Source: vevSource,
  };
  const created = await postJson(apiBase, '/api/createEditMaterial', payload);
  const createdEditMid =
    get(created, 'Result.EditMid') ||
    get(created, 'Result.MaterialId') ||
    get(created, 'Result.Id') ||
    '';
  if (createdEditMid) {
    return {
      editMid: createdEditMid,
      reused: false,
      raw: created,
    };
  }
  const createdMaterial = await findBySource();
  if (createdMaterial) {
    return {
      editMid: createdMaterial.EditMid || createdMaterial.editMid || createdMaterial.MaterialId || createdMaterial.Id || '',
      reused: false,
      raw: {
        create: created,
        search: createdMaterial,
      },
    };
  }
  return {
    editMid: '',
    reused: false,
    raw: created,
  };
}

async function publishMedia({ apiBase, vid }) {
  await postJson(apiBase, '/api/updateMediaPublishStatus', {
    Vid: vid,
    Status: 'Published',
  });
}

async function main() {
  const env = {
    ...parseEnvFile(ORIGIN_ENV_FILE),
    ...process.env,
  };
  for (const key of ['VOLC_ACCESS_KEY', 'VOLC_SECRET_KEY', 'VITE_VEV_PROJECT_ID', 'VITE_VEV_GROUP_ID']) {
    if (!env[key]) throw new Error(`Missing required env: ${key}`);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const videoTask = chooseVideoTask(db, argValue('video-task-id'));
  const sourcePath = path.join(DATA_DIR, 'videos', String(videoTask.owner_id), videoTask.filename);
  if (!fs.existsSync(sourcePath)) throw new Error(`Missing video file: ${sourcePath}`);

  const title = argValue('title') || videoTask.filename || `origin-${videoTask.id}.mp4`;
  const space = argValue('space', env.VITE_VEV_SPACE || 'origin');
  const apiBase = argValue('api-base', env.VITE_VEVDEMO_API_BASE || env.VEVDEMO_API_URL || 'http://127.0.0.1:3002');
  const workflowTemplateId = argValue('workflow-template-id', env.VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID || '');
  const reuseVid = argValue('reuse-vid');
  const timeoutMs = Number(argValue('timeout-ms', DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS;
  const pollMs = Number(argValue('poll-ms', DEFAULT_POLL_MS)) || DEFAULT_POLL_MS;
  const forceUpload = hasFlag('force-upload');
  const existing = getBinding(loadBindings(), 'video_task', videoTask.id, env.VITE_VEV_PROJECT_ID);
  if (existing && existing.vevSource && existing.vevEditMid && !forceUpload) {
    console.log(JSON.stringify({
      ok: true,
      reusedBinding: true,
      resourceId: videoTask.id,
      vevSource: existing.vevSource,
      vevEditMid: existing.vevEditMid,
      bindingsPath: BINDINGS_PATH,
    }, null, 2));
    return;
  }

  const service = createVodService(env);
  console.log(`[register-vevdemo] source video_task=${videoTask.id}`);
  console.log(`[register-vevdemo] source file=${sourcePath}`);
  console.log(`[register-vevdemo] space=${space} workflowTemplateId=${workflowTemplateId ? 'configured' : 'missing'}`);

  let vid = reuseVid;
  if (!vid) {
    const functions = buildUploadFunctions({ title, workflowTemplateId });
    const uploadRes = await service.UploadMedia({
      SpaceName: space,
      FilePath: sourcePath,
      FileExtension: '.mp4',
      Functions: JSON.stringify(functions),
    });
    const uploadError = apiError(uploadRes);
    if (uploadError) throw new Error(`UploadMedia failed: ${uploadError.Code || ''} ${uploadError.Message || ''}`);
    vid = get(uploadRes, 'Result.Data.Vid');
    if (!vid) throw new Error(`UploadMedia did not return Vid: ${JSON.stringify(uploadRes).slice(0, 500)}`);
    console.log(`[register-vevdemo] uploaded vid=${vid}`);
  } else {
    console.log(`[register-vevdemo] reusing vid=${vid}`);
  }

  await publishMedia({ apiBase, vid });
  console.log(`[register-vevdemo] published vid=${vid}`);
  const play = await waitForPlayable(service, vid, timeoutMs, pollMs);
  const vevSource = `vid://${vid}`;
  const editMaterial = await createOrReuseEditMaterial({
    apiBase,
    projectId: env.VITE_VEV_PROJECT_ID,
    space,
    title,
    vevSource,
  });
  if (!editMaterial.editMid) {
    throw new Error(`CreateEditMaterial succeeded but no EditMid was found for Source=${vevSource}`);
  }

  const entry = {
    resourceType: 'video_task',
    resourceId: videoTask.id,
    originProjectId: videoTask.project_id,
    ownerId: videoTask.owner_id,
    originFilePath: sourcePath,
    title,
    vid,
    vevSource,
    vevProjectId: env.VITE_VEV_PROJECT_ID,
    vevGroupId: env.VITE_VEV_GROUP_ID,
    vevSpace: space,
    vevEditMid: editMaterial.editMid,
    uploadedAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    uploadWorkflowTemplateId: workflowTemplateId || null,
    playInfo: {
      mainPlayUrl: play.summary.mainPlayUrl ? 'present' : '',
      backupPlayUrl: play.summary.backupPlayUrl ? 'present' : '',
      codecs: play.summary.codecs,
      h264: play.summary.h264,
    },
  };
  saveBinding(entry);

  console.log(JSON.stringify({
    ok: true,
    resourceId: videoTask.id,
    vid,
    vevSource,
    vevEditMid: editMaterial.editMid,
    reusedEditMaterial: editMaterial.reused,
    bindingsPath: BINDINGS_PATH,
  }, null, 2));
}

main().catch((error) => {
  console.error('[register-vevdemo] failed:', error.message || error);
  process.exitCode = 1;
});
