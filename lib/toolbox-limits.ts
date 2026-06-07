export const TOOLBOX_IMAGE_GENERATION_MAX_COUNT = 4;
export const TOOLBOX_IMAGE_REFERENCE_MAX_COUNT = 1;
// 图片在跑上限：单次最多 4 张并行 + 预留一次点击的余量。仅作过载/滥用软限流。
export const TOOLBOX_IMAGE_RUNNING_LIMIT = 8;
// 统计图片 running 项时，超过该时长的视为孤儿（图片为同步生成、无回收轮询），不计入限流，避免永久锁死。
export const TOOLBOX_IMAGE_RUNNING_STALE_MS = 10 * 60 * 1000;
export const TOOLBOX_VIDEO_RUNNING_LIMIT = 3;
export const TOOLBOX_HISTORY_DEFAULT_LIMIT = 30;
export const TOOLBOX_HISTORY_MAX_LIMIT = 100;
