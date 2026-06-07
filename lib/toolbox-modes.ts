import type { ImageGenInput } from './image-gen';
import type { VideoGenInput } from './video-gen';

export type ToolboxToolType = 'image' | 'video';
export type ToolboxSourceType = 'generated' | 'upload' | 'enhance';
export type ToolboxStatus = 'running' | 'completed' | 'failed';
export type ToolboxResultRefType = 'image' | 'video' | 'upload';

export type ToolboxMode =
  | 'text_to_image'
  | 'image_to_image'
  | 'image_to_video'
  | 'first_last_frame_video'
  | 'upload';

export type ToolboxInputRef = {
  role: 'reference' | 'first_frame' | 'tail_frame';
  refType: 'image' | 'upload';
  refId: string;
  mime?: string;
  name?: string;
  urlAtCreation?: string;
};

export type ToolboxImageParams = {
  ratio?: '1:1' | '9:16' | '16:9' | string;
  count?: number;
  quality?: ImageGenInput['quality'];
};

export type ToolboxVideoParams = {
  ratio?: '9:16' | '16:9' | '1:1' | string;
  resolution?: '720p' | '1080p' | string;
  durationSec?: number;
  cameraMotion?: string;
  cameraMotionDescription?: string;
  specialShot?: string;
};

export type ToolboxImageRatio = '1:1' | '9:16' | '16:9';
export type ToolboxVideoRatio = NonNullable<VideoGenInput['ratio']>;

export const TOOLBOX_CAMERA_MOTIONS = [
  '无',
  '固定机位',
  '跟拍',
  '环绕',
  '变焦拉近',
  '变焦拉远',
  '镜头左摇',
  '镜头右摇',
  '镜头上仰',
  '镜头下俯',
  '镜头前移',
  '镜头后移',
  '镜头左移',
  '镜头右移',
  '摇臂上升',
  '摇臂下降',
  '无人机航拍',
  '360°横滚',
];

export const TOOLBOX_SPECIAL_SHOTS = [
  '无',
  '希区柯克变焦',
  '延时摄影',
  '急推镜头',
  '急拉镜头',
  '快速甩镜',
  '子弹时间',
  'FPV穿梭',
  '微距特写',
  '第一人称',
  '慢镜头',
  '探针镜头',
  '旋转倾斜镜头',
];

export function normalizeToolboxMode(raw: unknown): ToolboxMode | null {
  const value = String(raw || '').trim();
  if (
    value === 'text_to_image' ||
    value === 'image_to_image' ||
    value === 'image_to_video' ||
    value === 'first_last_frame_video' ||
    value === 'upload'
  ) {
    return value;
  }
  return null;
}

export function normalizeToolboxImageRatio(ratio: unknown): ToolboxImageRatio | null {
  const value = String(ratio || '').trim();
  if (value === '1:1' || value === '9:16' || value === '16:9') return value;
  return null;
}

export function imageSizeForToolboxRatio(ratio: unknown): ImageGenInput['size'] {
  const value = normalizeToolboxImageRatio(ratio);
  if (!value) throw new Error(`图片比例无效：${String(ratio || '')}`);
  if (value === '9:16') return '1024x1536';
  if (value === '16:9') return '1536x1024';
  return '1024x1024';
}

export function normalizeToolboxVideoRatio(ratio: unknown): ToolboxVideoRatio {
  const value = String(ratio || '').trim();
  if (value === '9:16' || value === '16:9' || value === '1:1') return value;
  throw new Error(`视频画面比例无效：${String(ratio || '')}`);
}

export function normalizeToolboxVideoResolution(resolution: unknown): '720p' | '1080p' {
  const value = String(resolution || '').trim().toLowerCase();
  return value === '1080p' ? '1080p' : '720p';
}

// 运镜 / 特殊拍摄手法的"无效/未选择"哨兵。
// 历史构建用过英文默认值（'none' / 'static'），现版本用中文（'无'）。
// 这里统一忽略它们，避免把无意义值注入提示词。
const TOOLBOX_MOTION_SENTINELS = new Set(['', '无', 'none', 'static']);

function isToolboxMotionUnset(value: string): boolean {
  return TOOLBOX_MOTION_SENTINELS.has(value.trim().toLowerCase());
}

// 把图片 provider 的原始报错（尤其 Azure/OpenAI 的长 JSON moderation 报错）翻译成用户可懂的中文。
// 原始报错仍写日志 + 资产失败审计，便于排查；这里只决定"展示给用户看什么"。
export function toolboxImageFriendlyError(raw: string): string {
  const text = String(raw || '').trim();
  if (/moderation|safety|content[_ ]?policy|content management policy|image_generation_user_error|safety_violation|rejected|blocked/i.test(text)) {
    return '提示词或参考图未通过内容安全审核（例如涉及真实人物、敏感内容），请调整后重试。';
  }
  if (/retry_deadline_exceeded|timed?\s*out|timeout|超时|deadline/i.test(text)) {
    return '图片生成超时，请稍后重试。';
  }
  if (/rate.?limit|too many requests|\b429\b|限流/i.test(text)) {
    return '当前生成繁忙（限流），请稍后重试。';
  }
  return '图片生成失败，请调整提示词或稍后重试。';
}

// 把视频 provider 的晦涩报错翻译成用户可懂的文案；原始报错仍写日志 + 资产失败审计。
// 仅翻译已知的晦涩内部错误，其余保留原始信息（部分 provider 报错对用户是有用的）。
export function toolboxVideoFriendlyError(raw: string, mode: string): string {
  const text = String(raw || '').trim();
  if (/invalid svg|svg/i.test(text)) {
    return mode === 'first_last_frame_video'
      ? '首尾帧视频合成失败（首/尾帧图片解析异常）。请更换首/尾帧图片后重试，或改用图生视频。'
      : '图片解析异常，请更换图片后重试。';
  }
  if (/moderation|safety|content[_ ]?policy|rejected|blocked|安全审核/i.test(text)) {
    return '内容未通过安全审核（例如涉及真实人物、儿童或敏感内容），请调整提示词或参考图后重试。';
  }
  return text || '视频生成失败，请稍后重试。';
}

export function buildToolboxVideoPrompt(basePrompt: string, params: ToolboxVideoParams = {}) {
  const prompt = String(basePrompt || '').trim();
  const parts: string[] = [];
  const motion = String(params.cameraMotion || '').trim();
  const motionDesc = String(params.cameraMotionDescription || '').trim();
  const special = String(params.specialShot || '').trim();
  if (!isToolboxMotionUnset(motion)) parts.push(`镜头运动=${motion}`);
  if (motionDesc) parts.push(`镜头运动描述=${motionDesc}`);
  if (!isToolboxMotionUnset(special)) parts.push(`特殊拍摄手法=${special}`);
  if (!parts.length) return prompt;
  return `${prompt}\n\n工具箱参数：${parts.join('；')}。`;
}
