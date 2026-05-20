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

export function buildToolboxVideoPrompt(basePrompt: string, params: ToolboxVideoParams = {}) {
  const prompt = String(basePrompt || '').trim();
  const parts: string[] = [];
  const motion = String(params.cameraMotion || '').trim();
  const motionDesc = String(params.cameraMotionDescription || '').trim();
  const special = String(params.specialShot || '').trim();
  if (motion && motion !== '无') parts.push(`镜头运动=${motion}`);
  if (motionDesc) parts.push(`镜头运动描述=${motionDesc}`);
  if (special && special !== '无') parts.push(`特殊拍摄手法=${special}`);
  if (!parts.length) return prompt;
  return `${prompt}\n\n工具箱参数：${parts.join('；')}。`;
}
