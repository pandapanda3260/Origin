/**
 * 资产提取 in-flight 登记表（进程内存，非持久化）
 *
 * 为什么存在：/api/assets/extract 是一次性 SSE 请求，不走 batch 体系，
 * 不被 /api/batch/active 的刷新恢复覆盖。用户刷新页面会断开 SSE，但
 * sseResponse 的 handler 会继续跑完并落库（见 lib/sse.ts 的 cancel 语义：
 * 只停外发，不中止 handler）。这张表让前端刷新后还能查到"该项目的提取
 * 仍在后台进行"，从而续接进度 UI，并防止重复发起造成双扣积分。
 *
 * 设计取舍：
 * - 进程内 Map（挂 globalThis 防 dev HMR 重载丢状态），不写 DB——提取
 *   本身就活在本进程里，进程没了任务也没了，登记表跟着消失反而诚实。
 * - running 条目超过 STALE_RUNNING_MS 没有任何 step 更新，视为异常中断
 *   （罕见的后处理抛错没走到 end 钩子时的兜底），查询时自动翻成 error。
 * - 结束（done/error）条目保留 ENDED_KEEP_MS，给"完成/失败瞬间刚好刷新"
 *   的前端一个补课窗口，之后清掉。
 */

export type AssetExtractOutcome = 'done' | 'error';

export type AssetExtractState = {
  ownerId: string;
  projectId: string;
  status: 'running' | AssetExtractOutcome;
  step: string;
  pct: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  error?: string;
};

const STALE_RUNNING_MS = 15 * 60 * 1000;
const ENDED_KEEP_MS = 5 * 60 * 1000;

const _store: Map<string, AssetExtractState> =
  ((globalThis as any).__ORIGIN_ASSET_EXTRACT_INFLIGHT__ ||= new Map());

type OwnerId = string | number;

function _key(ownerId: OwnerId, projectId: string) {
  return `${String(ownerId)}:${projectId}`;
}

function _prune(now = Date.now()) {
  for (const [key, st] of _store) {
    if (st.status === 'running') {
      if (now - st.updatedAt > STALE_RUNNING_MS) {
        st.status = 'error';
        st.error = '提取超时或服务中断';
        st.endedAt = now;
        st.updatedAt = now;
      }
      continue;
    }
    if (st.endedAt && now - st.endedAt > ENDED_KEEP_MS) _store.delete(key);
  }
}

/** 开始登记。已有同项目 running 条目时拒绝（防双跑双扣费）。 */
export function beginAssetExtract(ownerId: OwnerId, projectId: string): { ok: boolean; existing?: AssetExtractState } {
  const now = Date.now();
  _prune(now);
  const key = _key(ownerId, projectId);
  const existing = _store.get(key);
  if (existing && existing.status === 'running') return { ok: false, existing };
  _store.set(key, {
    ownerId: String(ownerId),
    projectId,
    status: 'running',
    step: '正在分析剧本结构…',
    pct: 15,
    startedAt: now,
    updatedAt: now,
  });
  return { ok: true };
}

export function progressAssetExtract(ownerId: OwnerId, projectId: string, step: string, pct: number) {
  const st = _store.get(_key(ownerId, projectId));
  if (!st || st.status !== 'running') return;
  st.step = step;
  st.pct = pct;
  st.updatedAt = Date.now();
}

export function endAssetExtract(ownerId: OwnerId, projectId: string, outcome: AssetExtractOutcome, error?: string) {
  const st = _store.get(_key(ownerId, projectId));
  if (!st || st.status !== 'running') return;
  const now = Date.now();
  st.status = outcome;
  st.updatedAt = now;
  st.endedAt = now;
  if (outcome === 'error') st.error = error || '提取失败';
  if (outcome === 'done') {
    st.step = '提取完成';
    st.pct = 100;
  }
}

export function getAssetExtractState(ownerId: OwnerId, projectId: string): AssetExtractState | null {
  _prune();
  return _store.get(_key(ownerId, projectId)) || null;
}
