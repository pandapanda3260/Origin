/**
 * 剧本工作台时间线（scriptTimeline）：纯函数工具集。
 *
 * 设计见《剧本工作台-时间线信息流-方案.md》。要点：
 *   - 分集字段 scriptTimeline 是事件数组，三类事件：
 *       instruction（用户指令）/ draft（一版剧本草稿）/ system（系统事件一句话）
 *   - 草稿全文只保留最近 SCRIPT_TIMELINE_MAX_FULL_DRAFTS 版，更早的删
 *     script/emotionSegments 只留 summary（卡片变"仅摘要、不可恢复"）
 *   - 事件总数 SCRIPT_TIMELINE_MAX_EVENTS 封顶，FIFO 丢最老的
 *   - 前端有同口径实现 public/modules/script_timeline.js，改这里要同步改那边
 */

export type ScriptTimelineEvent = {
  id: string;
  ts: number;
  type: 'instruction' | 'draft' | 'system';
  /** instruction / system 的正文 */
  text?: string;
  /** instruction: revise|expand|convert ; draft: generate|revise|expand|import|edit|restore */
  source?: string;
  /** draft 专用：自增版本号（从 1 开始） */
  version?: number;
  /** draft 专用：剧本全文；超出保留窗口后被删除 */
  script?: string;
  /** draft 专用：首行摘要（≤40 字），裁剪后仍保留 */
  summary?: string;
  /** draft 专用：触发本版的指令事件 id */
  instructionId?: string;
  /** draft 专用：该版情绪段快照，恢复时一并恢复 */
  emotionSegments?: any[];
};

export const SCRIPT_TIMELINE_MAX_EVENTS = 200;
export const SCRIPT_TIMELINE_MAX_FULL_DRAFTS = 20;

export function newScriptTimelineId(): string {
  return 'ste_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function scriptTimelineSummary(script: string): string {
  const first =
    String(script || '')
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0] || '';
  return first.slice(0, 40);
}

export function latestScriptTimelineDraft(timeline: any): ScriptTimelineEvent | null {
  if (!Array.isArray(timeline)) return null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e && e.type === 'draft') return e as ScriptTimelineEvent;
  }
  return null;
}

/** 下一个 draft 版本号 = 历史最大版本 + 1（FIFO 裁剪后 length 不可靠，必须取 max） */
export function nextScriptTimelineVersion(timeline: any): number {
  let max = 0;
  if (Array.isArray(timeline)) {
    for (const e of timeline) {
      if (e && e.type === 'draft' && Number(e.version) > max) max = Number(e.version);
    }
  }
  return max + 1;
}

export function buildInstructionEvent(text: string, source: string): ScriptTimelineEvent {
  return { id: newScriptTimelineId(), ts: Date.now(), type: 'instruction', text: String(text || ''), source };
}

export function buildDraftEvent(opts: {
  version: number;
  script: string;
  source: string;
  instructionId?: string;
  emotionSegments?: any[];
}): ScriptTimelineEvent {
  const evt: ScriptTimelineEvent = {
    id: newScriptTimelineId(),
    ts: Date.now(),
    type: 'draft',
    version: opts.version,
    script: String(opts.script || ''),
    summary: scriptTimelineSummary(opts.script),
    source: opts.source,
  };
  if (opts.instructionId) evt.instructionId = opts.instructionId;
  if (Array.isArray(opts.emotionSegments) && opts.emotionSegments.length) {
    evt.emotionSegments = opts.emotionSegments;
  }
  return evt;
}

export function buildSystemEvent(text: string): ScriptTimelineEvent {
  return { id: newScriptTimelineId(), ts: Date.now(), type: 'system', text: String(text || '') };
}

/** append + 裁剪（总数 FIFO / 草稿全文窗口）。不修改入参，返回新数组。 */
export function appendScriptTimeline(timeline: any, events: ScriptTimelineEvent[]): ScriptTimelineEvent[] {
  let list: ScriptTimelineEvent[] = (Array.isArray(timeline) ? timeline : [])
    .filter((e: any) => e && typeof e === 'object')
    .map((e: any) => e as ScriptTimelineEvent);
  list = list.concat((events || []).filter(Boolean));
  if (list.length > SCRIPT_TIMELINE_MAX_EVENTS) {
    list = list.slice(list.length - SCRIPT_TIMELINE_MAX_EVENTS);
  }
  const draftIdx: number[] = [];
  list.forEach((e, i) => {
    if (e && e.type === 'draft') draftIdx.push(i);
  });
  const cut = draftIdx.length - SCRIPT_TIMELINE_MAX_FULL_DRAFTS;
  for (let k = 0; k < cut; k++) {
    const i = draftIdx[k];
    const e: any = list[i];
    if (e.script !== undefined || e.emotionSegments !== undefined) {
      const copy = { ...e };
      delete copy.script;
      delete copy.emotionSegments;
      list[i] = copy;
    }
  }
  return list;
}
