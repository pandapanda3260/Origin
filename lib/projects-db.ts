/**
 * 项目数据访问层（基于 SQLite）
 *
 * 项目的"宽数据"（剧本、资产、镜头、分镜、提示词、视频任务等）统一塞进 data_json 列。
 * 这样一来：
 *   - schema 简单（不需要 N 张子表）
 *   - 整个项目读一行就拿到全部，前端 saveProject() 直接整体覆盖
 *   - 后期需要做按字段查询时，再按需拆分
 *
 * 并发安全：
 *   - updateProjectForUser 把读 + 合并 + 写整体放进 db.transaction().immediate()，
 *     在同一事务内部再读一次最新 data_json 再合并，避免 TOCTOU 丢写。
 *   - 对于"读全项目 → 在 JS 里改数组某一项 → 写回"的典型模式（batch 执行器常用），
 *     应使用 patchProjectForUser(id, uid, patcher)：patcher 在事务里拿到最新数据，
 *     返回 patch 对象；这样多个 batch task 并发时每个都基于最新状态计算。
 */
import { randomUUID } from 'node:crypto';
import { getDb, type ProjectRow } from './db';
import {
  buildFrameWorkflowNormalizationPatch,
  maybeAssertStoryboardsAlignedWithShots,
} from './frame-workflow-state';
import { buildShotPlanDependencyPatch } from './project-dependency-state';
import { maybeMarkStyleBibleStale } from './script-style-state';
import { cleanStaleRunningComposeRuns, getComposeBootTs, markExportFailureInEditData } from './edit-auto-compose-state';
import {
  emptyScriptConsultState,
  isEmptyScriptConsultState,
  normalizeScriptConsultState,
} from './script-consult-state';
import { correctLatestScriptConsultReadyForRead } from './script-consult-ready';
import { isProjectCreatePayloadWhitelistEnabled } from './system-config';
import { createEmptyEpisode } from '../public/modules/episode_fields.js';

const STYLE_ASPECT_DEFAULT_VERSION = '2026-05-14-9x16';

const EMPTY_DATA = {
  currentStep: 1,
  idea: '',
  script: '',
  oneSentence: '',
  scriptTargetDurationSec: null as any,
  scriptApproved: false,
  scriptReviewState: '',
  scriptDraft: '',
  emotionSegments: null as any,
  scriptAnalysis: null as any,
  styleBible: { vision: '', narrative: '', camera: '', mood: '', promptHabits: '' },
  styleOptions: { aspectRatio: '9:16', aspectRatioDefaultVersion: STYLE_ASPECT_DEFAULT_VERSION },
  styleBibleStatus: '',
  styleBibleError: '',
  styleBibleGeneratedAt: null as any,
  styleBibleSource: null as any,
  styleBibleRunId: null as any,
  styleBibleStartedAt: null as any,
  styleBibleGenerationContext: null as any,
  styleBibleSourceHash: null as any,
  styleBibleStaleReason: null as any,
  styleBibleStaleSince: null as any,
  styleBibleManuallyEditedAt: null as any,
  selectedWorldTemplateId: null as any,
  worldTemplateSnapshot: null as any,
  pendingWorldFacts: null as any,
  selectedStyleTemplateId: null as any,
  styleTemplateSnapshot: null as any,
  characters: [] as any[],
  environments: [] as any[],
  props: [] as any[],
  assets: null as any,
  assetsApproved: false,
  shots: [] as any[],
  shotsApproved: false,
  storyboards: [] as any[],
  imagesApproved: false,
  videoPrompts: [] as any[],
  videoPromptsApproved: false,
  videoTasks: [] as any[],
  narrations: [] as any[],
  editData: null as any,
  episodes: [] as any[],
  currentEpisodeIdx: 0,
  // 部—集逻辑（docs/series-episode-continue-plan.md）：一集=一个任务，
  // seriesId=该部第一集的项目 id；episodeNumber=本任务是第几集；prevProjectId=上一集任务 id。
  seriesId: null as any,
  episodeNumber: null as any,
  prevProjectId: null as any,
  preferences: null as any,
  scriptConsult: emptyScriptConsultState(),
};

function normalizeProjectStyleDefaults(data: any) {
  const next = { ...(data || {}) };
  const styleOptions = { ...(next.styleOptions || {}) };
  if (!styleOptions.aspectRatioDefaultVersion) {
    if (!styleOptions.aspectRatio || styleOptions.aspectRatio === '16:9') {
      styleOptions.aspectRatio = '9:16';
    }
    styleOptions.aspectRatioDefaultVersion = STYLE_ASPECT_DEFAULT_VERSION;
  }
  next.styleOptions = styleOptions;
  return next;
}

const PROTECTED_ASSET_URL_KEYS = new Set([
  'imageUrl',
  'rawUrl',
  'realPhotoUrl',
  'pencilUrl',
  'coverUrl',
]);

function isEmptyAssetUrlValue(value: any) {
  return value === '' || value === null || typeof value === 'undefined';
}

function preserveExistingAssetUrls(existing: any, next: any) {
  if (!existing || !next || typeof existing !== 'object' || typeof next !== 'object') return;
  if (Array.isArray(existing) && Array.isArray(next)) {
    for (let i = 0; i < next.length; i += 1) preserveExistingAssetUrls(existing[i], next[i]);
    return;
  }
  if (Array.isArray(existing) || Array.isArray(next)) return;

  for (const key of Object.keys(next)) {
    if (PROTECTED_ASSET_URL_KEYS.has(key)) {
      if (isEmptyAssetUrlValue(next[key]) && !isEmptyAssetUrlValue(existing[key])) {
        next[key] = existing[key];
      }
      continue;
    }
    preserveExistingAssetUrls(existing[key], next[key]);
  }
}

const STYLE_BIBLE_LIFECYCLE_KEYS = [
  'styleBibleStatus',
  'styleBibleError',
  'styleBibleErrorCode',
  'styleBibleRunId',
  'styleBibleStartedAt',
  'styleBibleStage',
  'styleBibleProgress',
  'styleBibleNextRetryAt',
  'styleBibleHeartbeatAt',
] as const;

const STYLE_BIBLE_CONTENT_KEYS = [
  'styleBible',
  'styleBibleGeneratedAt',
  'styleBibleSource',
  'styleBibleSourceHash',
  'styleBibleGenerationContext',
  'styleBibleStaleReason',
  'styleBibleStaleSince',
  'styleBibleManuallyEditedAt',
] as const;

function preserveStyleBibleFields(existing: any, next: any, patch: any) {
  if (patch?.allowStyleBibleRunOverwrite === true) return;
  for (const key of [...STYLE_BIBLE_LIFECYCLE_KEYS, ...STYLE_BIBLE_CONTENT_KEYS]) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
      next[key] = existing?.[key] ?? null;
    }
  }
}

function rowToPublic(r: ProjectRow) {
  let data: any = {};
  try { data = JSON.parse(r.data_json || '{}'); } catch { data = {}; }
  const normalized = normalizeProjectStyleDefaults({
    ...EMPTY_DATA,
    ...data,
  });
  normalized.scriptConsult = correctLatestScriptConsultReadyForRead(
    normalizeScriptConsultState(normalized.scriptConsult),
    normalized.script,
  );
  return {
    id: r.id,
    ownerId: r.owner_id,
    // 原站前端代码同时使用 name 与 title，两者保持同值供任意一处读取
    name: r.title,
    title: r.title,
    description: r.description,
    coverUrl: r.cover_url,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...normalized,
    // version 放在 ...normalized 之后：data_json 里偶尔可能留下脏 version 字段，
    // 一律以列里的值为准。前端用它构造 If-Match 头。
    version: Number(r.version) || 1,
  };
}

function arr(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function firstValue(...values: any[]) {
  for (const value of values) {
    if (value !== null && typeof value !== 'undefined' && value !== '') return value;
  }
  return '';
}

function projectSummaryAssetCount(data: any): number {
  const assets = data?.assets || {};
  return arr(assets.characters || data?.characters).length
    + arr(assets.scenes || data?.environments).length
    + arr(assets.props || data?.props).length;
}

function projectSummarySegmentCount(data: any): number {
  return Math.max(
    arr(data?.storyboards).length,
    arr(data?.videoTasks).length,
    arr(data?.videoPrompts).length,
  );
}

function projectSummaryStatus(persisted: any, sb: any): 'pending' | 'running' | 'done' | 'failed' {
  if ((persisted && persisted.isCurrent === false) || (sb && sb.videoIsCurrent === false)) return 'pending';
  const raw = String(firstValue(persisted?.status, sb?.videoStatus) || '').toLowerCase();
  if (
    raw === 'done'
    || raw === 'completed'
    || raw === 'complete'
    || raw === 'succeeded'
    || (sb && sb.videoUrl && !raw)
  ) return 'done';
  if (raw === 'failed' || raw === 'timeout' || raw === 'cancelled' || raw === 'retry_failed') return 'failed';
  if (
    raw === 'polling'
    || raw === 'running'
    || raw === 'queued'
    || raw === 'submit'
    || raw === 'submitting'
    || raw === 'preparing'
    || raw === 'fetching'
    || raw === 'in_progress'
  ) return 'running';
  if (sb && sb.videoUrl) return 'done';
  return 'pending';
}

function projectSummaryStatusCounts(data: any) {
  const sbs = arr(data?.storyboards);
  const vts = arr(data?.videoTasks);
  const segmentCount = projectSummarySegmentCount(data);
  const counts = { running: 0, done: 0, failed: 0, pending: 0 };
  for (let i = 0; i < segmentCount; i += 1) {
    counts[projectSummaryStatus(vts[i] || {}, sbs[i] || {})] += 1;
  }
  return counts;
}

function projectSummaryStyleBibleUsable(data: any): boolean {
  const sb = data?.styleBible;
  if (!sb || typeof sb !== 'object') return false;
  const hasContent = Object.keys(sb).some((key) => {
    const value = (sb as any)[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return String(value || '').trim().length > 0;
  });
  if (!hasContent) return false;
  const status = data?.styleBibleStatus;
  return status === 'ready' || !status;
}

function projectSummaryCanEnterEdit(data: any): boolean {
  const editData = data?.editData || {};
  if (editData?.readiness?.canEnterEdit === true) return true;
  if (arr(editData?.edl?.timeline).length > 0) return true;
  return arr(data?.storyboards).some((sb: any) => sb && sb.importedToEdit === true);
}

export type ProjectStageInfo = {
  stage: 'script' | 'style' | 'assets' | 'shots' | 'images' | 'prompts' | 'batch' | 'edit' | 'done';
  done: number;
  total: number;
  failed: number;
  running: number;
};

// 资产阶段的产物倒推：已提取出资产且每个资产都有图 → 视为资产阶段已完成（用户常跳过"确认资产"按钮）。
// "有图"的字段口径对齐 public/modules/assets.js 的 _hasAssetImage（含真人参考/铅笔稿/参考锁/三视图面板）；
// 角色 reference.status=failed 视为未完成（casting 失败需回资产页处理）。
// 与前端 public/main.js 的 _ovAssetsArtifactComplete 保持同构，改一处必须同步另一处。
function projectSummaryAssetsArtifactComplete(data: any): boolean {
  const assets = data?.assets;
  if (!assets) return false;
  const groups: Array<{ list: any[]; isChar: boolean }> = [
    { list: arr(assets.characters), isChar: true },
    { list: arr(assets.scenes), isChar: false },
    { list: arr(assets.props), isChar: false },
  ];
  let count = 0;
  for (const group of groups) {
    for (const raw of group.list) {
      const it = raw || {};
      count += 1;
      const ref = it.reference && typeof it.reference === 'object' ? it.reference : {};
      const panels = it.panels && typeof it.panels === 'object' ? it.panels : {};
      if (group.isChar && String(ref.status || '').toLowerCase() === 'failed') return false;
      const url = firstValue(
        it.imageUrl, it.rawUrl, it.realPhotoUrl, it.pencilUrl,
        ref.currentUrl, ref.lastKnownGoodUrl,
        it.referenceLock?.sheetUrl,
        panels.sheetUrl, panels.frontUrl, panels.sideUrl, panels.backUrl,
      );
      if (!url) return false;
    }
  }
  return count > 0;
}

// 任务列表状态胶囊的"阶段"判定（与前端 public/main.js 的 _ovProjectStageInfo 保持同构，改一处必须同步另一处）。
// 思路：从最远的下游产物倒推阶段（成片 > 可剪辑 > 片段 > 提示词 > 镜头图 > 镜头设计），
// 不依赖 *Approved 确认 flag——实际数据里用户经常跳过确认按钮，flag 与真实进度脱节
// （例：已导出成片的项目 imagesApproved 仍是 false）。只有尚无任何生成产物的
// 早期创作阶段（剧本/风格/资产/镜头设计）才用 approve flag 区分，
// 其中资产阶段额外认产物：资产已提取且全部有图 → 视为完成推进到镜头设计（projectSummaryAssetsArtifactComplete）。
// 注意：有成片导出（editData.exportUrl）就算已完成，之后剪辑页再改动也不回退状态。
export function projectSummaryStageInfo(
  data: any,
  statusCounts: { running: number; done: number; failed: number; pending: number },
  segmentCount: number,
): ProjectStageInfo {
  const sbs = arr(data?.storyboards);
  const panelTotal = sbs.length;
  let imgDone = 0;
  let imgFailed = 0;
  let prReady = 0;
  let prGen = 0;
  let prFailed = 0;
  for (const raw of sbs) {
    const sb = raw || {};
    if (firstValue(sb.rawUrl, sb.imageUrl, sb.firstFrameUrl)) imgDone += 1;
    else if (sb.firstFrameLastError) imgFailed += 1;
    if (sb.videoPromptStatus === 'generating') prGen += 1;
    else if (sb.videoPromptStatus === 'failed') prFailed += 1;
    else if (sb.videoPrompt && (!sb.videoPromptStatus || sb.videoPromptStatus === 'ready')) prReady += 1;
  }
  const info = (
    stage: ProjectStageInfo['stage'],
    done = 0,
    total = 0,
    failed = 0,
    running = 0,
  ): ProjectStageInfo => ({ stage, done, total, failed, running });

  if (data?.editData?.exportUrl) return info('done', segmentCount, segmentCount);
  // 有片段正在生成：优先于"成片剪辑中"展示（重生成片段时回到片段生成态）。
  if (statusCounts.running > 0) {
    return info('batch', statusCounts.done, segmentCount, statusCounts.failed, statusCounts.running);
  }
  if (projectSummaryCanEnterEdit(data)) return info('edit', statusCounts.done, segmentCount);
  if (statusCounts.done + statusCounts.failed > 0) {
    // 片段全部完成 → 视为进入剪辑阶段（生成已结束，下一步就是剪）。
    if (segmentCount > 0 && statusCounts.done >= segmentCount) return info('edit', statusCounts.done, segmentCount);
    return info('batch', statusCounts.done, segmentCount, statusCounts.failed, statusCounts.running);
  }
  if (prReady + prGen + prFailed > 0) {
    // 提示词全就绪 → 下一步是片段生成，从 0% 开始展示。
    if (panelTotal > 0 && prReady >= panelTotal) return info('batch', 0, segmentCount);
    return info('prompts', prReady, panelTotal, prFailed, prGen);
  }
  if (imgDone + imgFailed > 0) {
    if (panelTotal > 0 && imgDone >= panelTotal) return info('prompts', prReady, panelTotal);
    return info('images', imgDone, panelTotal, imgFailed);
  }
  if (arr(data?.shots).length > 0) return info('images', imgDone, panelTotal || arr(data?.shots).length);
  if (!data?.script || !data?.scriptApproved) return info('script');
  if (!projectSummaryStyleBibleUsable(data)) return info('style');
  if (!data?.assetsApproved && !projectSummaryAssetsArtifactComplete(data)) return info('assets');
  return info('shots');
}

function projectSummaryDurationSec(data: any): number {
  const sbs = arr(data?.storyboards);
  const vts = arr(data?.videoTasks);
  let total = 0;
  for (let i = 0; i < Math.max(sbs.length, vts.length); i += 1) {
    const n = Number(firstValue(vts[i]?.durationSec, vts[i]?.duration_sec, sbs[i]?.videoDurationSec));
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

function projectSummaryThumbnail(data: any): string {
  const sbs = arr(data?.storyboards);
  const vts = arr(data?.videoTasks);
  for (let i = 0; i < Math.max(sbs.length, vts.length); i += 1) {
    const sb = sbs[i] || {};
    const vt = vts[i] || {};
    const thumbnail = firstValue(vt.coverUrl, vt.videoCoverUrl, sb.videoCoverUrl, sb.coverUrl, sb.rawUrl, sb.imageUrl);
    if (thumbnail) return String(thumbnail);
  }
  return '';
}

function rowToSummary(r: ProjectRow) {
  let data: any = {};
  try { data = JSON.parse(r.data_json || '{}'); } catch { data = {}; }
  const statusCounts = projectSummaryStatusCounts(data);
  const segmentCount = projectSummarySegmentCount(data);
  return {
    id: r.id,
    name: r.title,
    title: r.title,
    description: r.description,
    coverUrl: r.cover_url,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: Number(r.version) || 1,
    clientRequestId: data?.clientRequestId,
    // 部—集字段：任务列表分组/集数计算用（无则为 null，老项目不受影响）
    seriesId: data?.seriesId || null,
    episodeNumber: cleanEpisodeNumber(data?.episodeNumber),
    prevProjectId: data?.prevProjectId || null,
    assetCount: projectSummaryAssetCount(data),
    segmentCount,
    statusCounts,
    stageInfo: projectSummaryStageInfo(data, statusCounts, segmentCount),
    durationSec: projectSummaryDurationSec(data),
    thumbnail: projectSummaryThumbnail(data),
  };
}

function buildExportedEdlVersionBackfillPatch(project: any, userId: number) {
  const editData = project?.editData;
  if (!editData || !editData.exportUrl) return null;
  let next = editData;
  let changed = false;
  if (typeof next.exportedEdlVersion === 'undefined') {
    const edlVersion = Number(next?.edl?.version);
    if (Number.isFinite(edlVersion)) {
      next = { ...next, exportedEdlVersion: edlVersion };
      changed = true;
    }
  }
  if (!next.exportedEdlSignatureMeta) {
    const meta = buildExportedEdlSignatureMetaBackfill(project, userId);
    if (meta) {
      next = { ...next, exportedEdlSignatureMeta: meta };
      changed = true;
    }
  }
  return changed ? { editData: next } : null;
}

function parseExportMetaJson(value: unknown): Record<string, any> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function exportTaskIdFromEditData(editData: any) {
  const explicit = String(editData?.exportTaskId || '').trim();
  if (explicit) return explicit;
  const url = String(editData?.exportUrl || '').trim();
  const match = /\/api\/edit\/export-file\/([^/?#]+)/.exec(url);
  return match ? match[1] : '';
}

function buildExportedEdlSignatureMetaBackfill(project: any, userId: number) {
  const editData = project?.editData;
  const taskId = exportTaskIdFromEditData(editData);
  if (!editData || !taskId) return null;
  const row = getDb()
    .prepare<{ id: string; uid: number }, any>('SELECT id, bgm_id, edl_json FROM exports WHERE id = @id AND owner_id = @uid')
    .get({ id: taskId, uid: userId });
  if (!row) return null;

  const meta = parseExportMetaJson(row.edl_json);
  if (meta.exportedEdlSignatureMeta && typeof meta.exportedEdlSignatureMeta === 'object' && !Array.isArray(meta.exportedEdlSignatureMeta)) {
    return meta.exportedEdlSignatureMeta;
  }

  const exportFormat = meta.composeMeta?.exportFormat || {};
  const edlBgm = editData?.edl?.bgm && typeof editData.edl.bgm === 'object' ? editData.edl.bgm : null;
  const rowBgmId = String(meta.bgmId || row.bgm_id || '').trim();
  const edlTrackId = String(edlBgm?.trackId || '').trim();
  const bgmExplicitlyOn = !!(edlBgm && edlBgm.enabled === true);
  const bgmExplicitlyOff = !!(edlBgm && edlBgm.enabled === false);
  const suggestedBGMCategory = String(editData?.segmentTags?.suggestedBGMCategory || '').trim();
  const exportSegmentFingerprint = String(meta.composeMeta?.segmentFingerprint || '').trim();
  const currentSegmentFingerprint = String(editData?.segmentTags?.sourceFingerprint || '').trim();
  const segmentFingerprint = exportSegmentFingerprint || currentSegmentFingerprint;
  const canTreatAsAutoBgm = !!(
    bgmExplicitlyOn &&
    !edlTrackId &&
    rowBgmId &&
    suggestedBGMCategory &&
    exportSegmentFingerprint &&
    currentSegmentFingerprint &&
    exportSegmentFingerprint === currentSegmentFingerprint
  );
  const source = bgmExplicitlyOff
    ? 'off'
    : bgmExplicitlyOn && edlTrackId && edlTrackId === rowBgmId
      ? 'explicit'
      : canTreatAsAutoBgm
        ? 'auto'
        : 'none';
  const effectiveBgmId = source === 'auto' || source === 'explicit' ? rowBgmId : '';

  return {
    version: 1,
    taskId: row.id,
    exportFormat,
    bgm: {
      source,
      enabled: bgmExplicitlyOn && !!effectiveBgmId,
      trackId: effectiveBgmId,
      offsetTime: effectiveBgmId ? Math.max(0, Number(edlBgm?.offsetTime) || 0) : 0,
      suggestedBGMCategory,
      segmentFingerprint,
    },
  };
}

function buildFailedExportTaskCleanupPatch(project: any, userId: number) {
  const editData = project?.editData;
  const taskId = String(editData?.exportTaskId || '').trim();
  if (!editData || !taskId || editData.exportUrl) return null;
  const row = getDb()
    .prepare<{ id: string; uid: number }, any>('SELECT status, error_msg FROM exports WHERE id = @id AND owner_id = @uid')
    .get({ id: taskId, uid: userId });
  const status = String(row?.status || '');
  const failed = !row || status === 'failed' || status === 'timeout' || status === 'cancelled';
  if (!failed) return null;
  return {
    editData: markExportFailureInEditData(editData, {
      exportTaskId: taskId,
      errorCode: row ? 'EXPORT_FAILED' : 'EXPORT_TASK_MISSING',
      errorMessage: row?.error_msg || status || '导出任务记录消失',
    }),
  };
}

function buildStaleComposeRunCleanupPatch(project: any) {
  const editData = project?.editData;
  if (!editData) return null;
  // bootTs：重启孤儿（心跳早于本次进程启动）在 GET 水合时就清掉，
  // 前端"成片中"僵尸态刷新页面即自愈，不必等 10 分钟或点成片按钮。
  const cleaned = cleanStaleRunningComposeRuns(editData, undefined, getComposeBootTs());
  return cleaned.changed ? { editData: cleaned.editData } : null;
}

export function listProjectsByUser(userId: number) {
  const db = getDb();
  const rows = db
    .prepare<{ uid: number }, ProjectRow>(
      'SELECT * FROM projects WHERE owner_id = @uid ORDER BY created_at DESC',
    )
    .all({ uid: userId });
  return rows.map(rowToSummary);
}

/** 配额检查用：只数行，不解析 data_json（docs/series-episode-continue-plan.md §6.5）。 */
export function countProjectsForUser(userId: number): number {
  const db = getDb();
  const row = db
    .prepare<{ uid: number }, { c: number }>('SELECT COUNT(*) AS c FROM projects WHERE owner_id = @uid')
    .get({ uid: userId });
  return Number(row?.c) || 0;
}

export function getProjectByIdForUser(id: string, userId: number) {
  const perfDiag = process.env.PERF_DIAG === '1';
  const t0 = perfDiag ? performance.now() : 0;
  const db = getDb();
  const row = db
    .prepare<{ id: string; uid: number }, ProjectRow>(
      'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
    )
    .get({ id, uid: userId });
  const tSelect = perfDiag ? performance.now() : 0;
  if (!row) return null;
  const project = rowToPublic(row);
  const tRowToPublic = perfDiag ? performance.now() : 0;
  const normalizationPatch = buildFrameWorkflowNormalizationPatch(project, userId);
  const tNorm = perfDiag ? performance.now() : 0;
  const normalizedProject = { ...project, ...(normalizationPatch || {}) };
  const backfillPatch = buildExportedEdlVersionBackfillPatch({
    ...normalizedProject,
  }, userId);
  const tBackfill = perfDiag ? performance.now() : 0;
  const backfilledProject = { ...normalizedProject, ...(backfillPatch || {}) };
  const staleExportPatch = buildFailedExportTaskCleanupPatch(backfilledProject, userId);
  const tStaleExport = perfDiag ? performance.now() : 0;
  const staleExportProject = { ...backfilledProject, ...(staleExportPatch || {}) };
  const staleComposePatch = buildStaleComposeRunCleanupPatch(staleExportProject);
  const tStaleCompose = perfDiag ? performance.now() : 0;
  const combinedPatch = normalizationPatch || backfillPatch || staleExportPatch || staleComposePatch
    ? { ...(normalizationPatch || {}), ...(backfillPatch || {}), ...(staleExportPatch || {}), ...(staleComposePatch || {}) }
    : null;
  let tUpdate = tStaleCompose;
  if (combinedPatch) {
    const applied = applyPatchToRow(row, combinedPatch);
    const updateInfo = db.prepare(
      `UPDATE projects
       SET title = ?, description = ?, cover_url = ?, status = ?, data_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).run(applied.title, applied.description, applied.coverUrl, applied.status, applied.dataJson, id, userId, row.updated_at);
    tUpdate = perfDiag ? performance.now() : tUpdate;
    if (updateInfo.changes === 0) {
      const freshRow = db
        .prepare<{ id: string; uid: number }, ProjectRow>(
          'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
        )
        .get({ id, uid: userId });
      return freshRow ? rowToPublic(freshRow) : null;
    }
    if (perfDiag) {
      const fmt = (n: number) => n.toFixed(0);
      console.log(
        `[perf-diag] WIP getProjectByIdForUser id=${id} uid=${userId} total=${fmt(tUpdate - t0)}ms`
          + ` select=${fmt(tSelect - t0)}ms`
          + ` rowToPublic=${fmt(tRowToPublic - tSelect)}ms`
          + ` normalizationPatch=${fmt(tNorm - tRowToPublic)}ms`
          + ` backfillPatch=${fmt(tBackfill - tNorm)}ms`
          + ` staleExportPatch=${fmt(tStaleExport - tBackfill)}ms`
          + ` staleComposePatch=${fmt(tStaleCompose - tStaleExport)}ms`
          + ` update=${fmt(tUpdate - tStaleCompose)}ms`
          + ` patches=${[
              normalizationPatch ? 'norm' : '',
              backfillPatch ? 'backfill' : '',
              staleExportPatch ? 'staleExport' : '',
              staleComposePatch ? 'staleCompose' : '',
            ].filter(Boolean).join('+') || 'none'}`,
      );
    }
    return {
      ...project,
      ...combinedPatch,
    };
  }
  if (perfDiag) {
    const fmt = (n: number) => n.toFixed(0);
    console.log(
      `[perf-diag] WIP getProjectByIdForUser id=${id} uid=${userId} total=${fmt(tStaleCompose - t0)}ms`
        + ` select=${fmt(tSelect - t0)}ms`
        + ` rowToPublic=${fmt(tRowToPublic - tSelect)}ms`
        + ` normalizationPatch=${fmt(tNorm - tRowToPublic)}ms`
        + ` backfillPatch=${fmt(tBackfill - tNorm)}ms`
        + ` staleExportPatch=${fmt(tStaleExport - tBackfill)}ms`
        + ` staleComposePatch=${fmt(tStaleCompose - tStaleExport)}ms`
        + ` update=0ms patches=none`,
    );
  }
  return project;
}

export function createProjectForUser(userId: number, payload: any = {}) {
  const db = getDb();
  const id = (payload.id && typeof payload.id === 'string' && payload.id.length <= 100) ? payload.id : randomUUID();
  // 原站前端可能用 name 或 title 任一字段创建项目
  const title = (payload.name || payload.title || '未命名项目').toString().slice(0, 200);
  const description = (payload.description || '').toString().slice(0, 1000);
  const data = isProjectCreatePayloadWhitelistEnabled()
    ? buildNewProjectData(userId, id, payload)
    : {
        ...EMPTY_DATA,
        ...(payload || {}),
        oneSentence: (payload.oneSentence || payload.idea || '').toString().slice(0, 2000),
        scriptConsult: emptyScriptConsultState(),
      };
  // 把 name/title/description/coverUrl/status/id 这些"列字段"从 data_json 里去掉，避免重复
  delete data.id;
  delete data.name;
  delete data.title;
  delete data.description;
  delete data.coverUrl;
  delete data.status;
  delete data.createdAt;
  delete data.updatedAt;
  delete data.ownerId;
  db.prepare(
    'INSERT INTO projects (id, owner_id, title, description, status, data_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, title, description, 'draft', JSON.stringify(data));
  return getProjectByIdForUser(id, userId)!;
}

const NEW_PROJECT_ALLOWED_PAYLOAD_KEYS = new Set([
  'id',
  'name',
  'title',
  'description',
  'coverUrl',
  'status',
  'createdAt',
  'updatedAt',
  'ownerId',
  'currentStep',
  'idea',
  'oneSentence',
  'scriptTargetDurationSec',
  'styleOptions',
  'aspectRatio',
  'selectedWorldTemplateId',
  'worldTemplateSnapshot',
  'selectedStyleTemplateId',
  'styleTemplateSnapshot',
  'preferences',
  'episodes',
  'currentEpisodeIdx',
  'seriesId',
  'episodeNumber',
  'prevProjectId',
  'clientRequestId',
]);

function finiteDuration(value: any): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(60 * 60, Math.round(n));
}

function cleanId(value: any): string | null {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200) return null;
  return text;
}

function cleanPlainObject(value: any): any | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function cleanEpisodeNumber(value: any): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 1 || i > 100000) return null;
  return i;
}

function buildEmptyEpisode(payload: any) {
  const first = Array.isArray(payload?.episodes) ? payload.episodes[0] : null;
  return createEmptyEpisode({
    id: cleanId(first?.id) || undefined,
    title: first?.title || '第 1 集',
    scriptTargetDurationSec: payload?.scriptTargetDurationSec,
  });
}

function isEffectivelyEmptyCreateValue(key: string, value: any): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'boolean') return value === false;
  if (Array.isArray(value)) return value.length === 0;
  if (key === 'scriptConsult') return isEmptyScriptConsultState(value);
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function warnDiscardedCreateFields(userId: number, projectId: string, payload: any) {
  if (!payload || typeof payload !== 'object') return;
  const discardedKeys = Object.keys(payload).filter((key) => (
    !NEW_PROJECT_ALLOWED_PAYLOAD_KEYS.has(key) && !isEffectivelyEmptyCreateValue(key, payload[key])
  ));
  if (!discardedKeys.length) return;
  console.warn('[projects.create] discarded payload fields', {
    userId,
    projectId,
    discardedKeys,
    source: 'createProjectForUser',
    policyVersion: 'project-create-whitelist-v1',
  });
}

function buildNewProjectData(userId: number, projectId: string, payload: any = {}) {
  warnDiscardedCreateFields(userId, projectId, payload);
  const styleOptions = cleanPlainObject(payload.styleOptions) || {};
  if (payload.aspectRatio && !styleOptions.aspectRatio) styleOptions.aspectRatio = String(payload.aspectRatio).slice(0, 20);
  const oneSentence = (payload.oneSentence || payload.idea || '').toString().slice(0, 2000);
  return {
    ...EMPTY_DATA,
    currentStep: 1,
    idea: '',
    oneSentence,
    script: '',
    scriptDraft: '',
    scriptTargetDurationSec: finiteDuration(payload.scriptTargetDurationSec),
    scriptApproved: false,
    scriptReviewState: '',
    emotionSegments: null,
    scriptAnalysis: null,
    styleOptions: normalizeProjectStyleDefaults({ styleOptions }).styleOptions,
    selectedWorldTemplateId: cleanId(payload.selectedWorldTemplateId),
    worldTemplateSnapshot: cleanPlainObject(payload.worldTemplateSnapshot),
    selectedStyleTemplateId: cleanId(payload.selectedStyleTemplateId),
    styleTemplateSnapshot: cleanPlainObject(payload.styleTemplateSnapshot),
    scriptConsult: emptyScriptConsultState(),
    assets: null,
    assetsApproved: false,
    shots: [],
    shotsApproved: false,
    storyboards: [],
    imagesApproved: false,
    videoPrompts: [],
    videoPromptsApproved: false,
    videoTasks: [],
    narrations: [],
    editData: null,
    episodes: [buildEmptyEpisode(payload)],
    currentEpisodeIdx: 0,
    seriesId: cleanId(payload.seriesId),
    episodeNumber: cleanEpisodeNumber(payload.episodeNumber),
    prevProjectId: cleanId(payload.prevProjectId),
    preferences: cleanPlainObject(payload.preferences),
    clientRequestId: cleanId(payload.clientRequestId),
  };
}

function applyPatchToRow(existing: ProjectRow, patch: any): {
  title: string;
  description: string;
  coverUrl: string | null;
  status: string;
  dataJson: string;
} {
  let data: any = {};
  try { data = JSON.parse(existing.data_json || '{}'); } catch { data = {}; }
  const newData = { ...data, ...(patch || {}) };
	  const shouldPreserveAssetUrls = !patch?.allowEmptyAssetUrls;
	  if (shouldPreserveAssetUrls) preserveExistingAssetUrls(data, newData);
  preserveStyleBibleFields(data, newData, patch || {});
	  if (Object.prototype.hasOwnProperty.call(patch || {}, 'script')) {
	    const staleProbe = { ...data };
	    if (maybeMarkStyleBibleStale(staleProbe, newData.script, 'script_changed')) {
	      newData.styleBibleStaleReason = staleProbe.styleBibleStaleReason;
	      newData.styleBibleStaleSince = staleProbe.styleBibleStaleSince;
	    }
	  }

	  const title = patch.name ?? patch.title ?? existing.title;
  const description = patch.description ?? existing.description;
  const coverUrl = shouldPreserveAssetUrls
    && Object.prototype.hasOwnProperty.call(patch || {}, 'coverUrl')
    && isEmptyAssetUrlValue(patch.coverUrl)
    && !isEmptyAssetUrlValue(existing.cover_url)
    ? existing.cover_url
    : patch.coverUrl ?? existing.cover_url;
  const status = patch.status ?? existing.status;

  delete newData.id;
  delete newData.name;
  delete newData.title;
  delete newData.description;
  delete newData.coverUrl;
  delete newData.status;
  delete newData.createdAt;
  delete newData.updatedAt;
  delete newData.ownerId;
  delete newData.scriptLibrary;
  if (newData.scriptAnalysis && newData.scriptAnalysis.status === 'degraded') {
    delete newData.scriptAnalysis;
  }
  delete newData.allowEmptyAssetUrls;
  delete newData.allowStyleBibleRunOverwrite;
  // version 是真表列、不进 data_json；防止前端误传 { version: 9999 } 之类污染 JSON。
  delete newData.version;

  return {
    title,
    description,
    coverUrl,
    status,
    dataJson: JSON.stringify(newData),
  };
}

function applyPutShotPlanDependencyGuard(current: any, patch: any): any {
  if (!patch || typeof patch !== 'object') return patch;
  const candidate = { ...(current || {}), ...(patch || {}) };
  const dependencyPatch = buildShotPlanDependencyPatch({
    current,
    candidate,
    changedPatch: patch,
  });
  return dependencyPatch ? { ...patch, ...dependencyPatch } : patch;
}

type ProjectWriteOptions = {
  expectedVersion?: number;
  allowTitleUpdate?: boolean;
};

function stripImplicitTitleFields(patch: any, opts?: ProjectWriteOptions): any {
  if (!patch || typeof patch !== 'object' || opts?.allowTitleUpdate === true) return patch || {};
  const next = { ...patch };
  delete next.name;
  delete next.title;
  return next;
}

/**
 * 用 patch 覆盖/合并指定字段。在事务里重新读最新行再合并，防止 TOCTOU。
 * 注意：如果 patch 里的某个键是数组（如 storyboards），这里仍然是整体替换，
 *      和其他并发 writer 的数组修改之间仍然可能冲突——这类场景请用 patchProjectForUser。
 */
/**
 * 乐观锁失败：前端 If-Match 头里带的 version 已经落后于服务器当前 version。
 * 调用方（路由层）应该 catch 这个错误，返回 409 让前端拉新快照。
 */
export class StaleProjectVersionError extends Error {
  readonly serverVersion: number;
  readonly clientVersion: number;
  constructor(serverVersion: number, clientVersion: number) {
    super(`stale_version: server=${serverVersion} client=${clientVersion}`);
    this.name = 'StaleProjectVersionError';
    this.serverVersion = serverVersion;
    this.clientVersion = clientVersion;
  }
}

export function updateProjectForUser(
  id: string,
  userId: number,
  patch: any,
  opts?: ProjectWriteOptions,
) {
  const db = getDb();
  let hit = false;
  const txn = db.transaction(() => {
    const existing = db
      .prepare<{ id: string; uid: number }, ProjectRow>(
        'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
      )
      .get({ id, uid: userId });
    if (!existing) return;
    hit = true;
    // 乐观锁校验：调用方（PUT 路由）提供了 expectedVersion 时，必须和 DB 当前 version 一致。
    // 内部 patchProjectForUser / executor 写回不提供 expectedVersion，从而不被锁住。
    if (typeof opts?.expectedVersion === 'number') {
      const serverVersion = Number(existing.version) || 1;
      if (serverVersion !== opts.expectedVersion) {
        throw new StaleProjectVersionError(serverVersion, opts.expectedVersion);
      }
    }
    const current = rowToPublic(existing);
    const normalizationPatch = buildFrameWorkflowNormalizationPatch(current, userId);
    const normalizedCurrent = normalizationPatch ? { ...current, ...normalizationPatch } : current;
    const rawPatch = stripImplicitTitleFields(patch || {}, opts);
    const guardedPatch = applyPutShotPlanDependencyGuard(normalizedCurrent, rawPatch);
    const combinedPatch = normalizationPatch ? { ...normalizationPatch, ...guardedPatch } : guardedPatch;
    const touchesFrameStructure = ['shots', 'storyboards', 'videoTasks'].some((key) => (
      Object.prototype.hasOwnProperty.call(combinedPatch, key)
    ));
    const repairPatch = touchesFrameStructure
      ? buildFrameWorkflowNormalizationPatch({ ...normalizedCurrent, ...combinedPatch }, userId)
      : null;
    const finalPatch = repairPatch ? { ...combinedPatch, ...repairPatch } : combinedPatch;
    if (touchesFrameStructure) {
      maybeAssertStoryboardsAlignedWithShots(
        { ...normalizedCurrent, ...finalPatch },
        'updateProjectForUser',
      );
    }
    const applied = applyPatchToRow(existing, finalPatch);
    db.prepare(
      `UPDATE projects
       SET title = ?, description = ?, cover_url = ?, status = ?, data_json = ?,
           version = version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    ).run(applied.title, applied.description, applied.coverUrl, applied.status, applied.dataJson, id, userId);
  });
  txn.immediate();
  return hit ? getProjectByIdForUser(id, userId) : null;
}

/**
 * 读-改-写原子版：在事务内 SELECT 当前行，把解析出的项目对象交给 patcher，
 * patcher 返回 patch 对象（字段会浅合并到 data_json）。整个过程在 IMMEDIATE
 * 事务里完成，多个并发 batch task 串行化。
 *
 * 使用示例（批量执行器）：
 *   patchProjectForUser(projectId, userId, (current) => {
 *     const sbs = Array.isArray(current.storyboards) ? [...current.storyboards] : [];
 *     sbs[groupIdx] = { ...sbs[groupIdx], shotIndices: [groupIdx], imageUrl: url };
 *     return { storyboards: sbs };
 *   });
 */
export function patchProjectForUser(
  id: string,
  userId: number,
  patcher: (current: any) => any | null | undefined,
  opts?: ProjectWriteOptions,
) {
  const db = getDb();
  let hit = false;
  const txn = db.transaction(() => {
    const existing = db
      .prepare<{ id: string; uid: number }, ProjectRow>(
        'SELECT * FROM projects WHERE id = @id AND owner_id = @uid',
      )
      .get({ id, uid: userId });
    if (!existing) return;
    hit = true;
    const current = rowToPublic(existing);
    const normalizationPatch = buildFrameWorkflowNormalizationPatch(current, userId);
    const normalizedCurrent = normalizationPatch ? { ...current, ...normalizationPatch } : current;
    const patch = stripImplicitTitleFields(patcher(normalizedCurrent) || {}, opts);
    const combinedPatch = normalizationPatch ? { ...normalizationPatch, ...patch } : patch;
    if (Object.keys(combinedPatch).length === 0) return;
    const touchesFrameStructure = ['shots', 'storyboards', 'videoTasks'].some((key) => (
      Object.prototype.hasOwnProperty.call(combinedPatch, key)
    ));
    const repairPatch = touchesFrameStructure
      ? buildFrameWorkflowNormalizationPatch({ ...normalizedCurrent, ...combinedPatch }, userId)
      : null;
    const finalPatch = repairPatch ? { ...combinedPatch, ...repairPatch } : combinedPatch;
    if (touchesFrameStructure) {
      maybeAssertStoryboardsAlignedWithShots(
        { ...normalizedCurrent, ...finalPatch },
        'patchProjectForUser',
      );
    }
    const applied = applyPatchToRow(existing, finalPatch);
    db.prepare(
      `UPDATE projects
       SET title = ?, description = ?, cover_url = ?, status = ?, data_json = ?,
           version = version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    ).run(applied.title, applied.description, applied.coverUrl, applied.status, applied.dataJson, id, userId);
  });
  txn.immediate();
  return hit ? getProjectByIdForUser(id, userId) : null;
}

export function deleteProjectForUser(id: string, userId: number) {
  const db = getDb();
  const existing = db
    .prepare<{ id: string; uid: number }, { id: string }>(
      'SELECT id FROM projects WHERE id = @id AND owner_id = @uid',
    )
    .get({ id, uid: userId });
  if (!existing) return false;

  let deleted = false;
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM batch_tasks
       WHERE batch_id IN (SELECT id FROM batches WHERE owner_id = ? AND project_id = ?)`,
    ).run(userId, id);
    db.prepare('DELETE FROM batches WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM continuity_cache WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM style_bible_runs WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('DELETE FROM script_library_items WHERE owner_id = ? AND project_id = ?').run(userId, id);
    // Deleting a project removes the project container only. Generated/uploaded media is
    // retained for the asset library, downloads, and edit reuse.
    db.prepare('UPDATE images SET project_id = NULL WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('UPDATE video_tasks SET project_id = NULL WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare('UPDATE uploads SET project_id = NULL WHERE owner_id = ? AND project_id = ?').run(userId, id);
    db.prepare(
      `UPDATE assets
          SET project_relation_status = 'orphaned_project',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = ? AND project_id = ?`,
    ).run(userId, id);
    db.prepare(
      `UPDATE edit_projects
          SET status = 'deleted',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE owner_id = ? AND project_id = ?`,
    ).run(userId, id);
    db.prepare('DELETE FROM project_knowledge_contexts WHERE owner_id = ? AND project_id = ?').run(userId, id);
    // Keep derived world templates: they may be reused by other projects. Only sever provenance.
    db.prepare('UPDATE world_templates SET source_project_id = NULL WHERE owner_id = ? AND source_project_id = ?').run(userId, id);
    const info = db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, userId);
    deleted = info.changes > 0;
  });
  txn.immediate();
  return deleted;
}
