/**
 * 资产提取 in-flight 登记（lib/stage-inflight.ts 的薄壳）
 *
 * 历史：这套"登记 + 刷新续接 + 防重"机制最初为 /api/assets/extract 而写，
 * 后来剧本生成等同类一次性 SSE 任务也要用，于是把通用状态机抽到了
 * lib/stage-inflight.ts（stage 维度区分）。本文件保留原函数名，资产路由
 * 与契约测试（scripts/test-asset-extract-inflight.ts）继续走这里。
 */

import {
  beginStageRun,
  progressStageRun,
  endStageRun,
  getStageRun,
  type OwnerId,
  type StageInflightState,
  type StageOutcome,
} from './stage-inflight';

export const ASSET_EXTRACT_STAGE = 'assets_extract';

export type AssetExtractOutcome = StageOutcome;
export type AssetExtractState = StageInflightState;

/** 开始登记。已有同项目 running 条目时拒绝（防双跑双扣费）。 */
export function beginAssetExtract(ownerId: OwnerId, projectId: string): { ok: boolean; existing?: AssetExtractState } {
  return beginStageRun(ownerId, projectId, ASSET_EXTRACT_STAGE, { step: '正在分析剧本结构…', pct: 15 });
}

export function progressAssetExtract(ownerId: OwnerId, projectId: string, step: string, pct: number) {
  progressStageRun(ownerId, projectId, ASSET_EXTRACT_STAGE, step, pct);
}

export function endAssetExtract(ownerId: OwnerId, projectId: string, outcome: AssetExtractOutcome, error?: string) {
  endStageRun(ownerId, projectId, ASSET_EXTRACT_STAGE, outcome, error);
}

export function getAssetExtractState(ownerId: OwnerId, projectId: string): AssetExtractState | null {
  return getStageRun(ownerId, projectId, ASSET_EXTRACT_STAGE);
}
