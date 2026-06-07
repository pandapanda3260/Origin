// 镜头在所属"段"内的角色 —— 纯函数，供 executor / 素材生成 / UI 决策复用。
// 详见《镜头合并与素材生成-方案 v2》§3。无外部/原生依赖，便于单测。
import { planSegments } from './segment-planning';
import type { SegmentPlanShotLike, SegmentPlanOptions } from './segment-planning';

export interface ShotSegmentRole {
  /** 所属段下标（= storyboards 位置）。 */
  groupIdx: number;
  /** 段内位置（0-based）。 */
  positionInGroup: number;
  /** 段内镜头数。 */
  groupSize: number;
  /** 是否段首镜头。 */
  isSegmentFirst: boolean;
  /** 是否段尾镜头。 */
  isSegmentLast: boolean;
  /** 是否独段（段内仅 1 个镜头）。solo 必为段首且段尾。 */
  isSolo: boolean;
}

/** 由分段结果（number[][]）构建 "shot 下标 → 角色" 表。 */
export function buildShotRolesFromSegments(
  segments: ReadonlyArray<ReadonlyArray<number>>,
): ShotSegmentRole[] {
  const roles: ShotSegmentRole[] = [];
  segments.forEach((group, g) => {
    const size = group.length;
    group.forEach((shotIdx, pos) => {
      roles[shotIdx] = {
        groupIdx: g,
        positionInGroup: pos,
        groupSize: size,
        isSegmentFirst: pos === 0,
        isSegmentLast: pos === size - 1,
        isSolo: size === 1,
      };
    });
  });
  return roles;
}

/** 直接从镜头表 + 选项算角色表（内部调用 planSegments）。 */
export function buildShotRoles(
  shots: ReadonlyArray<SegmentPlanShotLike> | null | undefined,
  options?: SegmentPlanOptions,
): ShotSegmentRole[] {
  return buildShotRolesFromSegments(planSegments(shots, options));
}

/** 首帧：段首（含 solo）才生成/采纳。非段首镜头无首帧。 */
export function shouldGenerateFirstFrame(role: ShotSegmentRole | undefined | null): boolean {
  return !!role && role.isSegmentFirst;
}

/**
 * 尾帧锚点资格：只有 solo 镜头的尾帧能当结尾锚点
 * （合并段走参考模式、无尾锚点，故合并段的段尾不出尾帧）。
 * 是否"建议生成"还需叠加尾帧分值（由调用方判定）。
 */
export function tailFrameEligible(role: ShotSegmentRole | undefined | null): boolean {
  return !!role && role.isSolo;
}
