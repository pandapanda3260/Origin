export type TimeUsageSourceTable = 'batch_tasks' | 'generation_batches' | 'exports' | 'style_bible_runs';

export type TimeUsageFeature = {
  featureKey: string;
  featureLabel: string;
  moduleKey: string;
  moduleLabel: string;
  sourceTable: TimeUsageSourceTable;
  callItemType: string;
};

export type TimeUsageStatusGroup = 'success' | 'partial_success' | 'failed' | 'cancelled' | 'active' | 'unknown';

export const TIME_USAGE_BATCH_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export const TIME_USAGE_GENERATION_TERMINAL_STATUSES = ['success', 'partial_success', 'failed', 'cancelled'] as const;
export const TIME_USAGE_EXPORT_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export const TIME_USAGE_STYLE_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

const FEATURES: TimeUsageFeature[] = [
  feature('asset_character_image_batch', '角色图生成-批量', 'assets', '资产生成', 'batch_tasks', 'batch_task'),
  feature('asset_scene_image_batch', '场景图生成-批量', 'assets', '资产生成', 'batch_tasks', 'batch_task'),
  feature('asset_prop_image_batch', '道具图生成-批量', 'assets', '资产生成', 'batch_tasks', 'batch_task'),
  feature('storyboard_prompt_batch', '分镜图提示词生成', 'assets', '资产生成', 'batch_tasks', 'batch_task'),
  feature('first_frame_image_batch', '首帧图生成', 'assets', '资产生成', 'batch_tasks', 'batch_task'),
  feature('tail_frame_image_batch', '尾帧图生成', 'assets', '资产生成', 'batch_tasks', 'batch_task'),
  feature('shot_plan_batch_generate', '镜头表生成-批量', 'shots', '镜头规划', 'batch_tasks', 'batch_task'),
  feature('video_prompt_batch_generate', '视频提示词生成-批量', 'video_prompt', '视频提示词', 'batch_tasks', 'batch_task'),
  feature('video_segment_batch_generate', '视频段生成-批量', 'video', '视频生成', 'batch_tasks', 'batch_task'),
  feature('asset_character_image_single', '角色图生成-单次', 'assets', '资产生成', 'generation_batches', 'generation_batch'),
  feature('asset_scene_image_single', '场景图生成-单次', 'assets', '资产生成', 'generation_batches', 'generation_batch'),
  feature('asset_prop_image_single', '道具图生成-单次', 'assets', '资产生成', 'generation_batches', 'generation_batch'),
  feature('video_segment_single_generate', '视频段生成-单次', 'video', '视频生成', 'generation_batches', 'generation_batch'),
  feature('toolbox_image_generate', '工具箱图片生成', 'toolbox', '工具箱', 'generation_batches', 'generation_batch'),
  feature('toolbox_video_generate', '工具箱视频生成', 'toolbox', '工具箱', 'generation_batches', 'generation_batch'),
  feature('edit_export_render', '剪辑导出渲染', 'edit_export', '剪辑导出', 'exports', 'export'),
  feature('style_bible_extract', '风格圣经生成', 'style', '风格页面', 'style_bible_runs', 'style_bible_run'),
];

const FEATURE_BY_KEY = new Map(FEATURES.map((item) => [item.featureKey, item]));

export function listTimeUsageFeatures() {
  return [...FEATURES];
}

export function getTimeUsageFeature(featureKey: unknown): TimeUsageFeature | null {
  const key = String(featureKey || '').trim();
  return key ? FEATURE_BY_KEY.get(key) || null : null;
}

export function classifyBatchTaskFeature(batchType: unknown, targetType: unknown): TimeUsageFeature | null {
  const type = String(batchType || '').trim();
  if (type === 'asset_images') {
    const assetType = String(targetType || '').trim();
    if (assetType === 'char') return getTimeUsageFeature('asset_character_image_batch');
    if (assetType === 'scene') return getTimeUsageFeature('asset_scene_image_batch');
    if (assetType === 'prop') return getTimeUsageFeature('asset_prop_image_batch');
    return null;
  }
  if (type === 'storyboard_prompts') return getTimeUsageFeature('storyboard_prompt_batch');
  if (type === 'storyboard_images') return getTimeUsageFeature('first_frame_image_batch');
  if (type === 'tail_frame_images') return getTimeUsageFeature('tail_frame_image_batch');
  if (type === 'shots') return getTimeUsageFeature('shot_plan_batch_generate');
  if (type === 'video_prompts') return getTimeUsageFeature('video_prompt_batch_generate');
  if (type === 'video_segments' || type === 'videos') return getTimeUsageFeature('video_segment_batch_generate');
  return null;
}

export function classifyGenerationBatchFeature(stage: unknown, source: unknown): TimeUsageFeature | null {
  const normalizedStage = String(stage || '').trim();
  const normalizedSource = String(source || '').trim();
  if (normalizedStage === 'asset_character') return getTimeUsageFeature('asset_character_image_single');
  if (normalizedStage === 'asset_scene') return getTimeUsageFeature('asset_scene_image_single');
  if (normalizedStage === 'asset_prop') return getTimeUsageFeature('asset_prop_image_single');
  if (normalizedStage === 'video_segment' && normalizedSource === 'project') return getTimeUsageFeature('video_segment_single_generate');
  if (normalizedStage === 'toolbox_image' && normalizedSource === 'toolbox') return getTimeUsageFeature('toolbox_image_generate');
  if (normalizedStage === 'toolbox_video' && normalizedSource === 'toolbox') return getTimeUsageFeature('toolbox_video_generate');
  return null;
}

export function classifyExportFeature(provider: unknown, externalExportId: unknown): TimeUsageFeature | null {
  const hasProvider = !!String(provider || '').trim();
  const hasExternalId = !!String(externalExportId || '').trim();
  return hasProvider || hasExternalId ? null : getTimeUsageFeature('edit_export_render');
}

export function classifyStyleBibleFeature(): TimeUsageFeature {
  return getTimeUsageFeature('style_bible_extract')!;
}

export function normalizeTimeUsageStatus(status: unknown, sourceTable: TimeUsageSourceTable): {
  status: string;
  statusGroup: TimeUsageStatusGroup;
  isTerminal: boolean;
} {
  const raw = String(status || '').trim() || 'unknown';
  const terminal = terminalStatusesForSource(sourceTable);
  const isTerminal = terminal.has(raw);
  if (!isTerminal) return { status: raw, statusGroup: raw === 'unknown' ? 'unknown' : 'active', isTerminal: false };
  if (raw === 'completed' || raw === 'success') return { status: raw, statusGroup: 'success', isTerminal: true };
  if (raw === 'partial_success') return { status: raw, statusGroup: 'partial_success', isTerminal: true };
  if (raw === 'failed') return { status: raw, statusGroup: 'failed', isTerminal: true };
  if (raw === 'cancelled') return { status: raw, statusGroup: 'cancelled', isTerminal: true };
  return { status: raw, statusGroup: 'unknown', isTerminal: true };
}

export function buildBatchTaskCallItemLabel(featureKey: string, targetJson: unknown, seq: unknown): string {
  const target = parseObject(targetJson);
  const explicit = firstText(target.label, target.name, target.title);
  if (explicit) return explicit;
  const index = indexText(target.groupIdx, target.storyboardIdx, target.idx, seq);
  if (featureKey.startsWith('asset_character')) return `角色 ${index}`;
  if (featureKey.startsWith('asset_scene')) return `场景 ${index}`;
  if (featureKey.startsWith('asset_prop')) return `道具 ${index}`;
  if (featureKey === 'shot_plan_batch_generate') return '镜头表任务';
  if (featureKey === 'storyboard_prompt_batch') return `镜头 ${index}`;
  if (featureKey === 'first_frame_image_batch') return `分镜组 ${index}`;
  if (featureKey === 'tail_frame_image_batch') return `分镜组 ${index}`;
  if (featureKey === 'video_prompt_batch_generate') return `分镜组 ${index}`;
  if (featureKey === 'video_segment_batch_generate') return `视频段 ${index}`;
  return `任务 ${index}`;
}

export function buildGenerationBatchCallItemLabel(row: {
  featureKey?: string | null;
  batchId?: string | null;
  shotUid?: string | null;
  legacyShotId?: string | null;
  stage?: string | null;
}) {
  if (row.shotUid) return row.shotUid;
  if (row.legacyShotId) return row.legacyShotId.replace(/^shot_/, '镜头 ');
  const feature = getTimeUsageFeature(row.featureKey);
  return `${feature?.featureLabel || row.stage || '生成任务'} ${shortId(row.batchId)}`;
}

export function buildProjectDisplay(projectId: unknown, projectTitle: unknown, source: unknown) {
  const title = firstText(projectTitle);
  const id = firstText(projectId);
  if (title) return title;
  if (id) return id;
  return String(source || '') === 'toolbox' ? '工具箱' : '';
}

export function terminalStatusesForSource(sourceTable: TimeUsageSourceTable) {
  if (sourceTable === 'batch_tasks') return new Set<string>(TIME_USAGE_BATCH_TERMINAL_STATUSES);
  if (sourceTable === 'generation_batches') return new Set<string>(TIME_USAGE_GENERATION_TERMINAL_STATUSES);
  if (sourceTable === 'exports') return new Set<string>(TIME_USAGE_EXPORT_TERMINAL_STATUSES);
  return new Set<string>(TIME_USAGE_STYLE_TERMINAL_STATUSES);
}

function feature(
  featureKey: string,
  featureLabel: string,
  moduleKey: string,
  moduleLabel: string,
  sourceTable: TimeUsageSourceTable,
  callItemType: string,
): TimeUsageFeature {
  return { featureKey, featureLabel, moduleKey, moduleLabel, sourceTable, callItemType };
}

function parseObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text.slice(0, 160);
  }
  return '';
}

function indexText(...values: unknown[]) {
  for (const value of values) {
    const n = Math.floor(Number(value));
    if (Number.isFinite(n) && n >= 0) return String(n + 1);
  }
  return '-';
}

function shortId(value: unknown) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 8) : '';
}
