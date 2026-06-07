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
 * - 镜头 >= MIN → 单独成段（solo）
 * - 镜头 < MIN → 往后依次并入下一镜头，累计 >= MIN 即停（并入时不超过 MAX）
 * - 末段仍 < MIN → 整体并回上一段（1–7s 区间下数学保证 prev+last ≤ MAX）
 * 返回：每个元素是一段的 shot 下标运行段；保证升序、连续、覆盖全部下标、无重叠。
 *
 * 退化：整片仅一个 < MIN 的孤镜头 → 返回单段，交由生成时 padding，不在此特判。
 */
export function planSegments(
  shots: ReadonlyArray<SegmentPlanShotLike> | null | undefined,
  options: SegmentPlanOptions = {},
): number[][] {
  const MIN = Math.max(1, Math.floor(options.minDurationSec ?? SEGMENT_MIN_DURATION_SEC));
  const MAX = Math.max(MIN, Math.floor(options.maxDurationSec ?? SEGMENT_MAX_DURATION_SEC));
  const list = Array.isArray(shots) ? shots : [];
  const n = list.length;
  const segments: number[][] = [];

  let i = 0;
  while (i < n) {
    const di = shotDurationSec(list[i]);
    if (di >= MIN) {
      segments.push([i]);
      i += 1;
      continue;
    }
    const group: number[] = [i];
    let sum = di;
    let j = i + 1;
    while (sum < MIN && j < n) {
      const dj = shotDurationSec(list[j]);
      if (sum + dj > MAX) break; // 护栏：1–7s 区间下不会触发
      group.push(j);
      sum += dj;
      j += 1;
    }
    segments.push(group);
    i = j;
  }

  // 收尾兜底：末段仍 < MIN → 并回上一段。
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    const lastSum = last.reduce((acc, idx) => acc + shotDurationSec(list[idx]), 0);
    if (lastSum < MIN) {
      const prev = segments[segments.length - 2];
      segments[segments.length - 2] = prev.concat(last);
      segments.pop();
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
