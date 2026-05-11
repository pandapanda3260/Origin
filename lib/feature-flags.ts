function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(raw)) return true;
  return defaultValue;
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
 * 默认关闭，避免有老尾帧意图的项目在未确认时自动切换到互斥的首尾帧通道。
 */
export function isFirstLastFrameVideoModeEnabled(): boolean {
  return readBoolEnv('ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE', false);
}

/**
 * 尾帧 caption fallback：
 * 仅作为未来兼容不支持 last_frame 图片输入的 provider 的显式实验开关。
 * 默认关闭，避免视频生成前因为 legacy env 设置而隐式触发额外 vision/caption 调用。
 */
export function isTailFrameCaptionFallbackEnabled(): boolean {
  return readBoolEnv('ORIGIN_TAIL_FRAME_CAPTION_FALLBACK', false);
}
