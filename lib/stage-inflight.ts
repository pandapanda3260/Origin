/**
 * 分析型 SSE 任务的通用 in-flight 登记表（进程内存，非持久化）
 *
 * 适用对象：apiPostStream 驱动的一次性流式 LLM 任务（资产提取、剧本
 * 生成/改编/扩写等）。它们不走 batch 体系，不被 /api/batch/active 的
 * 刷新恢复覆盖；客户端刷新断开 SSE 后 handler 仍会跑完并落库（见
 * lib/sse.ts 的 cancel 语义：只停外发，不中止 handler）。这张表让前端
 * 刷新后能查到"该项目该阶段仍在后台进行"，从而续接进度 UI，并防止
 * 重复发起造成双扣积分。
 *
 * 设计取舍（与最初的 assets-extract-inflight 一致，加了 stage 维度）：
 * - 进程内 Map（挂 globalThis 防 dev HMR 重载丢状态），不写 DB——任务
 *   本身就活在本进程里，进程没了任务也没了，登记表跟着消失反而诚实。
 * - running 条目超过 STALE_RUNNING_MS 没有任何 step 更新，视为异常中断
 *   （罕见的后处理抛错没走到 end 钩子时的兜底），查询时自动翻成 error。
 * - 结束（done/error）条目保留 ENDED_KEEP_MS，给"完成/失败瞬间刚好刷新"
 *   的前端一个补课窗口，之后清掉。
 *
 * 已接线的 stage：
 *   - 'assets_extract'  → /api/assets/extract（经 lib/assets-extract-inflight 薄壳）
 *   - 'script_generate' → /api/script/workflow/{full-create,expand,consult/confirm}
 *     三条路由共用一个 stage：它们产出同一个工件（剧本），同项目同时只允许一路。
 */

export type StageOutcome = 'done' | 'error';
export type OwnerId = string | number;

/**
 * 剧本生成三路由（full-create / expand / consult/confirm）共用的 stage：
 * 它们产出同一个工件（剧本），同项目同时只允许一路在跑。
 */
export const SCRIPT_GENERATE_STAGE = 'script_generate';

export type StageInflightState = {
  ownerId: string;
  projectId: string;
  stage: string;
  status: 'running' | StageOutcome;
  step: string;
  pct: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  error?: string;
  /** 任意补充信息（如剧本生成的 mode: create/adapt/revise/expand），前端展示用 */
  meta?: Record<string, any>;
};

const STALE_RUNNING_MS = 15 * 60 * 1000;
const ENDED_KEEP_MS = 5 * 60 * 1000;

const _store: Map<string, StageInflightState> =
  ((globalThis as any).__ORIGIN_STAGE_INFLIGHT__ ||= new Map());

function _key(ownerId: OwnerId, projectId: string, stage: string) {
  return `${String(ownerId)}:${projectId}:${stage}`;
}

function _prune(now = Date.now()) {
  for (const [key, st] of _store) {
    if (st.status === 'running') {
      if (now - st.updatedAt > STALE_RUNNING_MS) {
        st.status = 'error';
        st.error = '任务超时或服务中断';
        st.endedAt = now;
        st.updatedAt = now;
      }
      continue;
    }
    if (st.endedAt && now - st.endedAt > ENDED_KEEP_MS) _store.delete(key);
  }
}

/** 开始登记。同项目同 stage 已有 running 条目时拒绝（防双跑双扣费）。 */
export function beginStageRun(
  ownerId: OwnerId,
  projectId: string,
  stage: string,
  init?: { step?: string; pct?: number; meta?: Record<string, any> },
): { ok: boolean; existing?: StageInflightState } {
  const now = Date.now();
  _prune(now);
  const key = _key(ownerId, projectId, stage);
  const existing = _store.get(key);
  if (existing && existing.status === 'running') return { ok: false, existing };
  _store.set(key, {
    ownerId: String(ownerId),
    projectId,
    stage,
    status: 'running',
    step: (init && init.step) || '正在处理…',
    pct: (init && typeof init.pct === 'number') ? init.pct : 10,
    startedAt: now,
    updatedAt: now,
    meta: init && init.meta ? { ...init.meta } : undefined,
  });
  return { ok: true };
}

export function progressStageRun(ownerId: OwnerId, projectId: string, stage: string, step: string, pct: number) {
  const st = _store.get(_key(ownerId, projectId, stage));
  if (!st || st.status !== 'running') return;
  st.step = step;
  st.pct = pct;
  st.updatedAt = Date.now();
}

export function endStageRun(ownerId: OwnerId, projectId: string, stage: string, outcome: StageOutcome, error?: string) {
  const st = _store.get(_key(ownerId, projectId, stage));
  if (!st || st.status !== 'running') return;
  const now = Date.now();
  st.status = outcome;
  st.updatedAt = now;
  st.endedAt = now;
  if (outcome === 'error') st.error = error || '任务失败';
  if (outcome === 'done') {
    st.step = '已完成';
    st.pct = 100;
  }
}

export function getStageRun(ownerId: OwnerId, projectId: string, stage: string): StageInflightState | null {
  _prune();
  return _store.get(_key(ownerId, projectId, stage)) || null;
}
