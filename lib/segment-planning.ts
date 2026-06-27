// 镜头合并 · 分组纯函数
// 把镜头按时长合并成"片段(段)"。详见《镜头合并与素材生成-方案 v2》§2。
// 仅依赖每个镜头的整数时长；无任何外部/原生依赖，便于单测。

export interface SegmentPlanShotLike {
  duration?: number | null;
  durationSec?: number | null;
}

export interface SegmentPlanOptions {
  /** Seedance 时长下限，默认 4。低于此值的镜头必须与相邻镜头合并。 */
  minDurationSec?: number;
  /** Seedance 时长上限，默认 15。合并时不得超过。 */
  maxDurationSec?: number;
  /** 目标段长下限；未传时沿用 minDurationSec。 */
  targetMinSec?: number;
  /** 目标段长上限；未传时沿用 maxDurationSec。 */
  targetMaxSec?: number;
  /** 物理硬上限；尾段并回也不得超过。 */
  hardMaxSec?: number;
}

export const SEGMENT_MIN_DURATION_SEC = 4;
export const SEGMENT_MAX_DURATION_SEC = 15;

/** 取镜头的整数计划秒数；非法/缺失按 1s 兜底（下游仍会 padding 到下限）。 */
export function shotDurationSec(shot: SegmentPlanShotLike | undefined | null): number {
  const raw = Number(shot?.duration ?? shot?.durationSec);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.round(raw));
}

/**
 * 按镜头顺序、前向贪心，把镜头合并成"段"。
 * - 镜头 >= targetMin → 单独成段（solo）
 * - 镜头 < targetMin → 往后依次并入下一镜头，累计 >= targetMin 即停（并入时不超过 hardMax）
 * - 末段仍 < targetMin → 仅在不超过 hardMax 时整体并回上一段
 * 返回：每个元素是一段的 shot 下标运行段；保证升序、连续、覆盖全部下标、无重叠。
 *
 * 退化：整片仅一个 < targetMin 的孤镜头 → 返回单段，交由生成时 padding，不在此特判。
 */
export function planSegments(
  shots: ReadonlyArray<SegmentPlanShotLike> | null | undefined,
  options: SegmentPlanOptions = {},
): number[][] {
  const TARGET_MIN = Math.max(1, Math.floor(options.targetMinSec ?? options.minDurationSec ?? SEGMENT_MIN_DURATION_SEC));
  const targetMaxInput = Math.floor(options.targetMaxSec ?? options.maxDurationSec ?? SEGMENT_MAX_DURATION_SEC);
  const TARGET_MAX = Math.max(TARGET_MIN, targetMaxInput);
  const hardMaxInput = Math.floor(options.hardMaxSec ?? TARGET_MAX);
  const HARD_MAX = Math.max(TARGET_MIN, hardMaxInput);
  const MAX = Math.min(TARGET_MAX, HARD_MAX);
  const list = Array.isArray(shots) ? shots : [];
  const n = list.length;
  const segments: number[][] = [];

  let i = 0;
  while (i < n) {
    const di = shotDurationSec(list[i]);
    if (di >= TARGET_MIN) {
      segments.push([i]);
      i += 1;
      continue;
    }
    const group: number[] = [i];
    let sum = di;
    let j = i + 1;
    while (sum < TARGET_MIN && j < n) {
      const dj = shotDurationSec(list[j]);
      if (sum + dj > MAX) break;
      group.push(j);
      sum += dj;
      j += 1;
    }
    segments.push(group);
    i = j;
  }

  // 收尾兜底：末段仍 < targetMin → 不超过 hardMax 才并回上一段。
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    const lastSum = last.reduce((acc, idx) => acc + shotDurationSec(list[idx]), 0);
    if (lastSum < TARGET_MIN) {
      const prev = segments[segments.length - 2];
      const prevSum = prev.reduce((acc, idx) => acc + shotDurationSec(list[idx]), 0);
      if (prevSum + lastSum <= HARD_MAX) {
        segments[segments.length - 2] = prev.concat(last);
        segments.pop();
      }
    }
  }

  return segments;
}

/** 把分段结果展开成 "shot 下标 → 段下标(groupIdx)" 映射。 */
export function shotIndexToSegment(segments: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const map: number[] = [];
  segments.forEach((group, gIdx) => {
    group.forEach((shotIdx) => {
      map[shotIdx] = gIdx;
    });
  });
  return map;
}
