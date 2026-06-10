// 剧本时间线（scriptTimeline）前端工具：与 lib/script-timeline.ts 同口径，
// 改任意一边必须同步另一边。事件结构/裁剪规则见《剧本工作台-时间线信息流-方案.md》。

export var SCRIPT_TIMELINE_MAX_EVENTS = 200;
export var SCRIPT_TIMELINE_MAX_FULL_DRAFTS = 20;

export function newScriptTimelineId() {
  return "ste_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function scriptTimelineSummary(script) {
  var first = String(script || "").trim().split("\n").map(function (s) { return s.trim(); }).filter(Boolean)[0] || "";
  return first.slice(0, 40);
}

export function latestScriptTimelineDraft(timeline) {
  if (!Array.isArray(timeline)) return null;
  for (var i = timeline.length - 1; i >= 0; i--) {
    var e = timeline[i];
    if (e && e.type === "draft") return e;
  }
  return null;
}

// 下一个 draft 版本号 = 历史最大版本 + 1（FIFO 裁剪后 length 不可靠，必须取 max）
export function nextScriptTimelineVersion(timeline) {
  var max = 0;
  if (Array.isArray(timeline)) {
    for (var i = 0; i < timeline.length; i++) {
      var e = timeline[i];
      if (e && e.type === "draft" && Number(e.version) > max) max = Number(e.version);
    }
  }
  return max + 1;
}

export function buildInstructionEvent(text, source) {
  return { id: newScriptTimelineId(), ts: Date.now(), type: "instruction", text: String(text || ""), source: source };
}

export function buildDraftEvent(opts) {
  opts = opts || {};
  var evt = {
    id: newScriptTimelineId(),
    ts: Date.now(),
    type: "draft",
    version: opts.version,
    script: String(opts.script || ""),
    summary: scriptTimelineSummary(opts.script),
    source: opts.source,
  };
  if (opts.instructionId) evt.instructionId = opts.instructionId;
  if (Array.isArray(opts.emotionSegments) && opts.emotionSegments.length) evt.emotionSegments = opts.emotionSegments;
  return evt;
}

export function buildSystemEvent(text) {
  return { id: newScriptTimelineId(), ts: Date.now(), type: "system", text: String(text || "") };
}

// append + 裁剪（总数 FIFO / 草稿全文窗口）。不修改入参，返回新数组。
export function appendScriptTimeline(timeline, events) {
  var list = (Array.isArray(timeline) ? timeline : []).filter(function (e) { return e && typeof e === "object"; });
  list = list.concat((events || []).filter(Boolean));
  if (list.length > SCRIPT_TIMELINE_MAX_EVENTS) list = list.slice(list.length - SCRIPT_TIMELINE_MAX_EVENTS);
  var draftIdx = [];
  list.forEach(function (e, i) { if (e && e.type === "draft") draftIdx.push(i); });
  var cut = draftIdx.length - SCRIPT_TIMELINE_MAX_FULL_DRAFTS;
  for (var k = 0; k < cut; k++) {
    var i = draftIdx[k];
    var e = list[i];
    if (e.script !== undefined || e.emotionSegments !== undefined) {
      var copy = Object.assign({}, e);
      delete copy.script;
      delete copy.emotionSegments;
      list[i] = copy;
    }
  }
  return list;
}

// 相对时间："刚刚 / n 分钟前 / n 小时前 / n 天前 / 月-日"
export function scriptTimelineTimeAgo(ts) {
  var n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  var diff = Date.now() - n;
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + " 小时前";
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + " 天前";
  var d = new Date(n);
  return (d.getMonth() + 1) + "-" + d.getDate();
}

export var SCRIPT_TIMELINE_SOURCE_LABELS = Object.freeze({
  generate: "生成",
  revise: "改写",
  expand: "扩充",
  import: "导入",
  edit: "手动编辑",
  restore: "恢复",
  convert: "转换",
});
