function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(raw)) return true;
  return defaultValue;
}

export type VideoSubmitMode = 'auto' | 'strict_first_frame' | 'first_last_frame' | 'reference_images';

function readEnumEnv<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return (allowed as readonly string[]).includes(raw) ? raw as T : fallback;
}

/**
 * 视频提交模式唯一入口：
 * - auto: 按片段条件选择最稳的合法模式。
 * - strict_first_frame: 首帧按 Seedance first_frame 提交，其他视觉参考降级到提示词。
 * - first_last_frame: 仅允许官方首尾帧通道。
 * - reference_images: 多图全部按 reference_image 提交，牺牲严格首帧换多视觉参考。
 *
 * 默认 auto 是产品策略选择；如需完全复用旧多图行为，可显式设为 reference_images。
 */
export function getVideoSubmitMode(): VideoSubmitMode {
  return readEnumEnv('VIDEO_SUBMIT_MODE', ['auto', 'strict_first_frame', 'first_last_frame', 'reference_images'] as const, 'auto');
}

/**
 * 多参生视频模式：
 * - on: 分镜槽位生成彩色视频首帧，并让视频生成优先使用首帧 + 多资产参考。
 * - off: 保持旧的黑白铅笔分镜主流程。
 *
 * 默认开启，方便当前产品链路直接进入新模式；如需回滚，设置
 * ORIGIN_MULTI_REF_VIDEO_MODE=0 即可退回旧链路。
 */
export function isMultiRefVideoModeEnabled(): boolean {
  return readBoolEnv('ORIGIN_MULTI_REF_VIDEO_MODE', true);
}

/**
 * 独立多图视频模式：
 * - on: 给 Seedance 传多张独立 image_url(reference_image)，并在 prompt 中逐张编号说明。
 * - off: 继续使用当前已验证的"彩色首帧强控制"路径。
 *
 * 默认开启，进入 P0 多图链路；如需回滚，设置
 * ORIGIN_INDEPENDENT_MULTI_IMAGE_MODE=0 即可退回首帧单图/旧参考路径。
 */
export function isIndependentMultiImageModeEnabled(): boolean {
  return readBoolEnv('ORIGIN_INDEPENDENT_MULTI_IMAGE_MODE', true);
}

/**
 * 首尾帧图生视频模式：
 * - on: 允许视频 executor 在满足模型能力、首帧、尾帧状态后走 Builder A
 *   (content: text + first_frame + last_frame)。
 * - off: 稳定回退到 Builder B（首帧 + 多参考图），尾帧只保留为 UI/数据状态。
 *
 * 默认开启；仍要求 tailFrameIntent=requested、尾帧 ready、模型 capability
 * supported，且可用 ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE=0 快速回滚。
 */
export function isFirstLastFrameVideoModeEnabled(): boolean {
  return readBoolEnv('ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE', true);
}

/**
 * 多镜头片段模式（镜头合并）：
 * - on: 镜头计划阶段把相邻短镜头合并成"段"（一段 = 一次生成），解决 <下限 的快镜头被顶时长、破坏节奏的问题。
 * - off: 维持"一个片段 = 一个镜头"的旧行为。
 *
 * 默认开启（合并已是默认行为）。如需临时停用，设 ORIGIN_MULTI_SHOT_SEGMENT=0 一键回退，无需改码。
 */
export function isMultiShotSegmentEnabled(): boolean {
  return readBoolEnv('ORIGIN_MULTI_SHOT_SEGMENT', true);
}

/**
 * 分镜首帧候选模型：
 * - on: storyboard_images 从 group target 展开为 per-shot target, 写入 shotFrames[shotUid].candidates。
 * - off: 保持旧的一段一张段首首帧行为。
 *
 * 默认关闭，确保旧页和旧生成链路零行为变化。
 */
export function isPerShotFirstFrameEnabled(): boolean {
  return readBoolEnv('ORIGIN_PER_SHOT_FIRST_FRAME', false);
}

/**
 * 尾帧 caption fallback：
 * 仅作为未来兼容不支持 last_frame 图片输入的 provider 的显式实验开关。
 * 默认关闭，避免视频生成前因为 legacy env 设置而隐式触发额外 vision/caption 调用。
 */
export function isTailFrameCaptionFallbackEnabled(): boolean {
  return readBoolEnv('ORIGIN_TAIL_FRAME_CAPTION_FALLBACK', false);
}

export function getKnowledgeSelectiveInjectionStages(): string[] {
  const raw = String(process.env.KNOWLEDGE_SELECTIVE_INJECTION_STAGES || '').trim();
  if (!raw) return [];
  if (raw === '*') return ['*'];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isKnowledgeSelectiveInjectionEnabledForStage(stage: string): boolean {
  const stages = getKnowledgeSelectiveInjectionStages();
  return stages.includes('*') || stages.includes(stage);
}
