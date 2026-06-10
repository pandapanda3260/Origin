/**
 * scroll_anchor_guard.js — 全局滚动锚定守卫（根治长列表重渲染滚动跳变）
 *
 * 【问题类】本工程大量"整列表销毁重建"式渲染（renderShotList 整清 wrap、
 * renderImageGrid 全槽位回退骨架再回填、SSE/轮询完成回调刷新等，仅 storyboard.js
 * 就有 35 处 renderImageGrid 调用点）。重建瞬间文档高度塌缩，浏览器把
 * window.scrollY 钳到塌缩后的最大值且不会自动滚回，高度回填后用户就从
 * 镜头 11/13 "跳回镜头 2"。逐调用点打补丁不可维护——本模块在 window 滚动层
 * 一次性兜住所有现有与未来的重建路径。
 *
 * 【机制】三件事：
 *   1. 连续锚定：用户滚动停下后，记住"视口顶部是哪张卡 + 它的视口 top"。
 *      只跟随用户发起的滚动（输入后 800ms 内，或由其引发的连续滚动 burst，
 *      涵盖平滑滚动/惯性滚动）；高度塌缩导致的钳制滚动是孤立事件，不会被
 *      误认成用户意图。
 *   2. MutationObserver 监听主内容区 DOM 重建；重建后下一帧检查锚点卡片
 *      是否还在原视口位置，偏差超过阈值就瞬时滚回去（发生在绘制前，肉眼
 *      看不到跳动），随后 ~700ms 内吸收图片/面板异步水合造成的高度漂移。
 *   3. 用户优先：任何 wheel/触摸/鼠标按下/按键立即让位；切页面、切项目
 *      （context 变化）锚点作废，不干扰"导航回顶部"的既有语义。
 *
 * 【接入】只保护注册在 SCOPES 里的页（window 滚动的长列表页）。新页面要
 * 接入，加一行 scope（卡片选择器 + 稳定 id 属性）即可，无需改业务渲染代码。
 * fixed-workbench 页（script/style/edit/prompts/onlineEditor）不走 window
 * 滚动，不在本守卫范围。
 */

/* 每页的锚点卡片定义：selector 必须能选出"页内主列表的卡片级元素"，
 * idAttr 是跨重建稳定的身份属性（重建后用它找回同一张卡）。 */
var SCOPES = {
  shots: { selector: ".shot-workbench-card[data-shot-idx]", idAttr: "data-shot-idx" },
  batch: { selector: "#batchTaskListWrap > [data-group-idx]", idAttr: "data-group-idx" },
};

var TOP_GUARD_PX = 100;      // 视口顶部留给吸顶头部的区域，锚点取第一张"底边越过该线"的卡
var RESTORE_THRESHOLD = 24;  // 锚点偏离超过该值才回滚（小漂移交给浏览器原生 scroll anchoring）
var INPUT_FRESH_MS = 800;    // 输入后多久内的滚动算"用户滚动"
var BURST_EXTEND_MS = 300;   // 用户滚动 burst 的延续窗口（平滑/惯性滚动）
var SETTLE_TICKS = 6;        // 回滚后的校正次数
var SETTLE_INTERVAL_MS = 120;

var _getContext = null;
var _anchor = null;          // { ctx, page, id, top }
var _lastInputTs = 0;
var _followUntil = 0;
var _restoring = false;
var _restoreSeq = 0;
var _scrollRaf = 0;
var _checkRaf = 0;
var _inited = false;

function _now() { return Date.now(); }

function _ctx() {
  try { return _getContext ? String(_getContext()) : ""; } catch (_) { return ""; }
}

function _pageOfCtx(ctx) { return ctx.split("|")[0] || ""; }

function _scrollY() { return window.scrollY || window.pageYOffset || 0; }

/* 取当前视口锚点：扫当前页 scope 的卡片，找第一张可见且底边越过 TOP_GUARD 的。 */
function _pickAnchor() {
  var ctx = _ctx();
  var scope = SCOPES[_pageOfCtx(ctx)];
  if (!scope) return null;
  var els;
  try { els = document.querySelectorAll(scope.selector); } catch (_) { return null; }
  for (var i = 0; i < els.length; i++) {
    var r = els[i].getBoundingClientRect();
    if (!r.height) return null; // 页面 display:none（rect 全 0），不锚定
    if (r.bottom > TOP_GUARD_PX) {
      var id = els[i].getAttribute(scope.idAttr);
      if (id == null) return null;
      return { ctx: ctx, page: _pageOfCtx(ctx), id: String(id), top: r.top };
    }
  }
  return null;
}

function _resolveAnchorEl() {
  if (!_anchor) return null;
  var scope = SCOPES[_anchor.page];
  if (!scope) return null;
  var els;
  try { els = document.querySelectorAll(scope.selector); } catch (_) { return null; }
  for (var i = 0; i < els.length; i++) {
    if (String(els[i].getAttribute(scope.idAttr)) === _anchor.id) return els[i];
  }
  return null;
}

function _onUserInput() { _lastInputTs = _now(); }

/* 滚动跟随：只有用户发起（或其延续 burst）的滚动才更新锚点。
 * 高度塌缩钳制是"无输入的孤立滚动"，不进这个分支 → 锚点保住塌缩前的位置。 */
function _onScroll() {
  if (_scrollRaf) return;
  _scrollRaf = requestAnimationFrame(function () {
    _scrollRaf = 0;
    if (_restoring) return;
    var now = _now();
    var userDriven = (now - _lastInputTs) < INPUT_FRESH_MS || now < _followUntil;
    if (!userDriven) return;
    _followUntil = now + BURST_EXTEND_MS;
    var a = _pickAnchor();
    if (a) _anchor = a;
  });
}

/* DOM 变更后的检查：锚点卡还在原视口位置吗？不在就拉回来。 */
function _onMutations() {
  if (_checkRaf) return;
  _checkRaf = requestAnimationFrame(function () {
    _checkRaf = 0;
    _check();
  });
}

function _check() {
  var ctx = _ctx();
  if (!SCOPES[_pageOfCtx(ctx)]) return;        // 当前页未注册，不管
  if (!_anchor || _anchor.ctx !== ctx) {       // 没锚点/锚点过期 → 静默重新武装
    _anchor = _pickAnchor();
    return;
  }
  if (_restoring) return;
  var el = _resolveAnchorEl();
  if (!el) { _anchor = _pickAnchor(); return; } // 锚点卡被删（如删镜头）→ 重新武装
  var r = el.getBoundingClientRect();
  if (!r.height && !r.width) return;            // 页面隐藏，等 context 变化自然作废
  var dev = r.top - _anchor.top;
  if (Math.abs(dev) <= RESTORE_THRESHOLD) {
    _anchor.top = r.top;                        // 小漂移：吸收进锚点，不动滚动
    return;
  }
  if ((_now() - _lastInputTs) < 250) return;    // 用户刚操作过，让位
  _restore();
}

/* 瞬时回滚 + settle 校正：吸收随后异步水合（图片/素材面板）带来的高度漂移。 */
function _restore() {
  var seq = ++_restoreSeq;
  var startedAt = _now();
  var ticks = 0;
  _restoring = true;
  function step() {
    if (seq !== _restoreSeq) return;                        // 有更新一轮的恢复在跑
    if (_lastInputTs > startedAt) return _finish();         // 用户接管
    if (!_anchor || _anchor.ctx !== _ctx()) return _finish();
    var el = _resolveAnchorEl();
    if (!el) return _finish();
    var r = el.getBoundingClientRect();
    if (!r.height && !r.width) return _finish();
    var dev = r.top - _anchor.top;
    if (Math.abs(dev) > 2) window.scrollTo(0, Math.max(0, _scrollY() + dev));
    ticks++;
    if (ticks <= SETTLE_TICKS) setTimeout(step, SETTLE_INTERVAL_MS);
    else _finish();
  }
  function _finish() {
    if (seq !== _restoreSeq) return;
    _restoring = false;
    var a = _pickAnchor();                                  // 以最终落点重新武装
    if (a) _anchor = a;
  }
  step();
}

export function initScrollAnchorGuard(opts) {
  if (_inited) return;
  _inited = true;
  _getContext = (opts && opts.getContext) || null;
  ["wheel", "touchstart", "mousedown", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, _onUserInput, { capture: true, passive: true });
  });
  window.addEventListener("scroll", _onScroll, { passive: true });
  var root = document.querySelector("main.main-area") || document.body;
  try {
    var mo = new MutationObserver(_onMutations);
    mo.observe(root, { childList: true, subtree: true });
  } catch (e) {
    console.warn("[ScrollAnchorGuard] MutationObserver unavailable:", e);
  }
}
