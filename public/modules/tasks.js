/**
 * Global Task Center + Maintenance Banner — extracted from main.js (stage 3 refactor).
 *
 * Phase 3-B-9：任务中心从 15 秒 setInterval 轮询改为
 * `/api/tasks/all-active/stream` SSE 长连接；后端每 5 秒算一次指纹，
 * 同一快照不重复推，心跳 15 秒一次。
 *
 * 保留的 _interval 字段现在仅用作"SSE 断开后的降级兜底"：连续
 * `_MAX_SSE_FAILS` 次连接失败才回退到 polling，避免网络抖动就疯狂切。
 */
import { escapeHtml, showToast, apiGet, formatTime, getAuthHeaders, $ } from './utils.js';
const _getAuthHeaders = getAuthHeaders;

let _ctx = {};
let project = null;

export function initTasks(ctx) { _ctx = ctx; }
export function syncTasksProject(p) { project = p; }

  /* ═══════════════════════════════════════════════════════════════
   *  Global Task Center — cross-project inbox (server-backed)
   * ═══════════════════════════════════════════════════════════════ */

  var _globalTaskCenter = {
    tasks: [],
    lastFetch: 0,
    interval: null,      // 仅作降级兜底用
    inflight: false,
    eventSource: null,   // Phase 3-B-9 SSE
    sseFailCount: 0,
    sseReconnectTimer: null,
  };
  var _MAX_SSE_FAILS = 3;
  var _SSE_RECONNECT_BASE_MS = 2000;

  function _gtcTypeLabel(t) {
    var tt = (t && t.task_type) || "";
    var tg = (t && t.target_type) || "";
    if (tt === "video") return "片段 " + ((t.target_idx || 0) + 1);
    if (tt === "storyboard") return "分镜 " + ((t.target_idx || 0) + 1);
    if (tt === "stylize" || tt === "style") return "风格化" + (tg === "char" ? "角色" : "");
    if (tt === "derive") return "场景变体";
    if (tt === "image") {
      if (tg === "char") return "角色图";
      if (tg === "scene") return "场景图";
      if (tg === "prop") return "道具图";
      return "图片";
    }
    if (tt === "export") return "成片导出";
    return "任务";
  }

  function _gtcStatusLabel(s) {
    if (s === "pending") return "排队中";
    if (s === "polling") return "生成中";
    if (s === "done") return "已完成";
    if (s === "failed") return "失败";
    return s || "";
  }

  /**
   * Circular progress indicator. We don't have real percent data from the
   * upstream provider, so we animate a rotating indeterminate ring while
   * status is pending/polling, draw a green checkmark on done, and a red
   * cross on failed. Built as inline SVG so it's self-contained / themable
   * without extra assets.
   */
  export function _gtcProgressHtml(status) {
    if (status === "done") {
      return '<div class="gtc-ring gtc-ring-done" aria-label="已完成">' +
        '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="none" stroke="#66BB6A" stroke-width="2"/><path d="M7 12 L11 16 L17 9" fill="none" stroke="#66BB6A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>';
    }
    if (status === "failed") {
      return '<div class="gtc-ring gtc-ring-failed" aria-label="失败">' +
        '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="none" stroke="#E57373" stroke-width="2"/><path d="M8 8 L16 16 M16 8 L8 16" fill="none" stroke="#E57373" stroke-width="2.4" stroke-linecap="round"/></svg>' +
      '</div>';
    }
    // pending / polling: indeterminate rotating arc.
    return '<div class="gtc-ring gtc-ring-run" aria-label="生成中">' +
      '<svg viewBox="0 0 24 24" width="24" height="24">' +
        '<circle cx="12" cy="12" r="10" fill="none" stroke="rgba(11,19,32,0.1)" stroke-width="2"/>' +
        '<circle cx="12" cy="12" r="10" fill="none" stroke="#0B1320" stroke-width="2" stroke-linecap="round" stroke-dasharray="16 48" />' +
      '</svg>' +
    '</div>';
  }

  function _gtcFormatTime(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso.indexOf("Z") >= 0 || iso.indexOf("+") >= 0 ? iso : iso + "Z");
      var now = Date.now();
      var diff = Math.max(0, Math.floor((now - d.getTime()) / 1000));
      if (diff < 60) return diff + "秒前";
      if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
      if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
      return Math.floor(diff / 86400) + "天前";
    } catch (e) { return ""; }
  }

  function _gtcPageForTask(t) {
    var tt = (t && (t.task_type || t.target_type)) || "";
    if (tt === "video") return "video";
    if (tt === "image" || tt === "style") return "assets";
    if (tt === "export") return "edit";
    return "overview";
  }

  async function _loadGlobalTaskCenter() {
    if (_globalTaskCenter.inflight) return;
    _globalTaskCenter.inflight = true;
    try {
      var resp = await fetch("/api/tasks/all-active", { headers: _getAuthHeaders() });
      if (!resp.ok) { _globalTaskCenter.inflight = false; return; }
      var data = await resp.json();
      _globalTaskCenter.tasks = (data && data.tasks) || [];
      _globalTaskCenter.lastFetch = Date.now();
      _renderGlobalTaskCenter();
      _updateGlobalTaskBadge();
    } catch (e) {
      // Silent: polling runs every 15s, one miss is fine.
    }
    _globalTaskCenter.inflight = false;
  }

  function _gtcBuildCard(t, isCross) {
    var card = document.createElement("div");
    card.className = "global-task-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.dataset.projectId = t.project_id || "";
    card.dataset.targetPage = _gtcPageForTask(t);
    card.dataset.taskId = t.task_id || "";

    // Ring replaces the old tiny dot — gives users actual progress
    // feedback per the request.
    var ringWrap = document.createElement("div");
    ringWrap.className = "shrink-0";
    ringWrap.innerHTML = _gtcProgressHtml(t.status);
    card.appendChild(ringWrap);

    var body = document.createElement("div");
    body.className = "flex-1 min-w-0";
    var line1 = document.createElement("p");
    line1.className = "text-xs font-bold truncate";
    if (isCross) {
      line1.textContent = (t.project_name || t.project_id || "未命名项目") + " · " + _gtcTypeLabel(t);
    } else {
      line1.textContent = _gtcTypeLabel(t);
    }
    var line2 = document.createElement("p");
    line2.className = "text-[10px] text-on-surface-variant/60 truncate";
    line2.textContent = _gtcStatusLabel(t.status) + (t.error_msg ? " · " + t.error_msg : "");
    body.appendChild(line1);
    body.appendChild(line2);
    card.appendChild(body);

    var time = document.createElement("span");
    time.className = "text-[10px] font-mono text-on-surface-variant/30 shrink-0";
    time.textContent = _gtcFormatTime(t.updated_at);
    card.appendChild(time);

    if (isCross) {
      card.addEventListener("click", _onCrossProjectTaskClick);
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); _onCrossProjectTaskClick.call(card, e); }
      });
    }
    return card;
  }

  function _renderGlobalTaskCenter() {
    var wrap = $("globalTaskListWrap");
    if (!wrap) return;
    var currentId = (typeof project !== "undefined" && project) ? project.id : "";
    var serverTasks = _globalTaskCenter.tasks || [];

    // Split into current-project vs other-project, and for the current
    // project skip 'video' tasks — those have their own richer local
    // renderer (_syncGlobalTaskCard with live statusCn). Everything else
    // (image / storyboard / stylize / derive) was previously invisible in
    // the task center, which is issue #2 the user hit.
    var currentProject = [];
    var crossProject = [];
    serverTasks.forEach(function (t) {
      if (!t || !t.project_id) return;
      if (t.project_id === currentId) {
        if (t.task_type !== "video") currentProject.push(t);
      } else {
        crossProject.push(t);
      }
    });

    // Always rebuild both managed sections from scratch. Local video
    // `.gtp-card` siblings are left untouched.
    var prevCurrent = document.getElementById("gtpCurrentProjectSection");
    if (prevCurrent) prevCurrent.remove();
    var prevCross = document.getElementById("gtpCrossProjectSection");
    if (prevCross) prevCross.remove();

    function buildSection(id, headerText, items, isCross) {
      var section = document.createElement("div");
      section.id = id;
      section.style.marginBottom = "8px";
      var header = document.createElement("div");
      header.className = "text-[10px] font-bold tracking-wide text-on-surface-variant/60";
      header.style.padding = "4px 4px 6px";
      header.textContent = headerText + " · " + items.length;
      section.appendChild(header);
      items.forEach(function (t) { section.appendChild(_gtcBuildCard(t, isCross)); });
      return section;
    }

    var anchor = wrap.firstChild;
    if (crossProject.length > 0) {
      wrap.insertBefore(buildSection("gtpCrossProjectSection", "其他项目", crossProject, true), anchor);
    }
    if (currentProject.length > 0) {
      wrap.insertBefore(buildSection("gtpCurrentProjectSection", "本项目", currentProject, false), wrap.firstChild);
    }

    var emptyEl = $("globalTaskEmpty");
    if (emptyEl) {
      var hasAny = currentProject.length > 0 || crossProject.length > 0 ||
        (wrap.querySelector(".gtp-card") !== null);
      emptyEl.hidden = hasAny;
    }
  }

  function _onCrossProjectTaskClick(e) {
    var card = e.currentTarget || this;
    var pid = card.dataset.projectId;
    var page = card.dataset.targetPage || "overview";
    if (!pid) return;
    try {
      toggleGlobalTaskPanel(false);
      if (typeof project !== "undefined" && project && project.id === pid) {
        _ctx.switchPage(page);
      } else {
        switchToProject(pid);
        setTimeout(function () { try { _ctx.switchPage(page); } catch (_) {} }, 400);
      }
    } catch (err) {
      console.warn("[GlobalTaskCenter] navigate failed:", err);
    }
  }

  function _updateGlobalTaskBadge() {
    var gBadge = $("globalTaskBadge");
    if (!gBadge) return;
    var local = typeof activeTaskCount === "function" ? activeTaskCount() : 0;
    var currentId = (typeof project !== "undefined" && project) ? project.id : "";
    var cross = (_globalTaskCenter.tasks || []).filter(function (t) {
      return t && t.project_id && t.project_id !== currentId;
    }).length;
    var total = local + cross;
    if (total > 0) { gBadge.textContent = String(total); gBadge.classList.add("active"); }
    else { gBadge.classList.remove("active"); }
  }

  /**
   * Phase 3-B-9：SSE 长连接接收活跃任务快照。
   *
   * 后端指纹去重 + 每 5 秒巡检一次，客户端只消费；收到就整包覆盖
   * `_globalTaskCenter.tasks` 再 render。断线时 2s / 4s / 8s 退避
   * 重连；超过 `_MAX_SSE_FAILS` 次回退到 15s 老轮询确保不完全瞎。
   */
  function _startGlobalTaskCenterStream() {
    if (_globalTaskCenter.eventSource) return;

    // EventSource 不能带 Authorization header，鉴权走 ?token=xxx（app.py
    // auth_middleware 的 SSE 白名单里已经支持 /api/tasks/*/stream）
    var token = "";
    try {
      token = localStorage.getItem("sw_auth_token") || "";
    } catch (_e) {}
    var url = "/api/tasks/all-active/stream" + (token ? ("?token=" + encodeURIComponent(token)) : "");

    var es;
    try {
      es = new EventSource(url);
    } catch (e) {
      console.warn("[GlobalTaskCenter] EventSource ctor failed, falling back to polling:", e);
      _startGlobalTaskCenterPollingFallback();
      return;
    }
    _globalTaskCenter.eventSource = es;

    function handleTaskCenterSnapshot(ev) {
      try {
        var payload = JSON.parse(ev.data);
        var data = (payload && payload.data !== undefined) ? payload.data : payload;
        _globalTaskCenter.tasks = (data && (data.items || data.tasks)) || [];
        _globalTaskCenter.lastFetch = Date.now();
        _globalTaskCenter.sseFailCount = 0;
        _renderGlobalTaskCenter();
        _updateGlobalTaskBadge();
      } catch (e) {
        console.warn("[GlobalTaskCenter] parse task snapshot failed:", e);
      }
    }

    es.addEventListener("snapshot", handleTaskCenterSnapshot);
    es.addEventListener("tasks_changed", handleTaskCenterSnapshot);
    es.addEventListener("tasks_snapshot", handleTaskCenterSnapshot);

    es.addEventListener("error", function () {
      // 浏览器已经在自动重连，但连续失败太多就主动切 polling
      _globalTaskCenter.sseFailCount += 1;
      if (_globalTaskCenter.sseFailCount >= _MAX_SSE_FAILS) {
        console.warn("[GlobalTaskCenter] SSE failed >=" + _MAX_SSE_FAILS + " times, fallback to polling");
        try { es.close(); } catch (_e) {}
        _globalTaskCenter.eventSource = null;
        _startGlobalTaskCenterPollingFallback();
      }
    });
  }

  function _startGlobalTaskCenterPollingFallback() {
    if (_globalTaskCenter.interval) return;
    _loadGlobalTaskCenter();
    _globalTaskCenter.interval = setInterval(_loadGlobalTaskCenter, 15000);
  }

  /**
   * 对外导出的入口名字维持 `_startGlobalTaskCenterPoll`（main.js 一路引用着），
   * 内部切 SSE 优先，失败再回 polling。
   */
  function _startGlobalTaskCenterPoll() {
    // 先拉一次同步快照保证 UI 在订阅 SSE 之前就有数据，不然首屏要等 5s
    _loadGlobalTaskCenter();
    _startGlobalTaskCenterStream();
  }

  /* ═══════════════════════════════════════════════════════════════
   *  Maintenance Banner — polled every 10s, soft-blocks new jobs
   *  when a deploy is imminent (remaining < 30s).
   * ═══════════════════════════════════════════════════════════════ */

  var _maintBanner = {
    enabled: false,
    message: "",
    expiresAt: 0,
    interval: null,
    tickInterval: null,
    lastToastAt: 0,
  };

  async function checkMaintenanceBanner() {
    try {
      // Public endpoint, no Authorization needed.
      var resp = await fetch("/api/maintenance/banner", { cache: "no-store" });
      if (!resp.ok) return;
      var data = await resp.json();
      _maintBanner.enabled = !!(data && data.enabled);
      _maintBanner.message = (data && data.message) || "";
      _maintBanner.expiresAt = (data && data.expiresAt) || 0;
      _renderMaintBanner();
    } catch (e) { /* silent */ }
  }

  function _maintRemainingSeconds() {
    if (!_maintBanner.enabled || !_maintBanner.expiresAt) return 0;
    return Math.max(0, _maintBanner.expiresAt - Math.floor(Date.now() / 1000));
  }

  function _renderMaintBanner() {
    var el = document.getElementById("maintenanceBanner");
    if (!el) return;

    var remaining = _maintRemainingSeconds();
    if (!_maintBanner.enabled || (_maintBanner.expiresAt > 0 && remaining === 0)) {
      el.hidden = true;
      document.body.classList.remove("has-maint-banner");
      if (_maintBanner.tickInterval) {
        clearInterval(_maintBanner.tickInterval);
        _maintBanner.tickInterval = null;
      }
      return;
    }

    el.hidden = false;
    document.body.classList.add("has-maint-banner");
    var msgEl = el.querySelector(".mb-msg");
    var cntEl = el.querySelector(".mb-count");
    if (msgEl) msgEl.textContent = _maintBanner.message || "系统即将升级维护，请稍后再开始新任务";
    if (cntEl) {
      if (remaining > 0) {
        var m = Math.floor(remaining / 60);
        var s = remaining % 60;
        cntEl.textContent = m > 0
          ? (m + "分" + (s < 10 ? "0" + s : s) + "秒后开始")
          : (s + "秒后开始");
        cntEl.hidden = false;
      } else {
        cntEl.hidden = true;
      }
    }
    if (remaining > 0 && remaining <= 30) el.classList.add("mb-urgent");
    else el.classList.remove("mb-urgent");

    if (!_maintBanner.tickInterval && _maintBanner.expiresAt > 0) {
      _maintBanner.tickInterval = setInterval(_renderMaintBanner, 1000);
    }
  }

  /**
   * Soft-block callable — invoke before starting any potentially expensive
   * job (video/image generation, export, etc.). Returns true when the caller
   * should proceed, false when it should abort.
   */
  window.maintenanceSoftBlock = function maintenanceSoftBlock() {
    var remaining = _maintRemainingSeconds();
    if (!_maintBanner.enabled || remaining <= 0 || remaining > 30) return true;
    var now = Date.now();
    if (now - _maintBanner.lastToastAt > 3000) {
      _maintBanner.lastToastAt = now;
      try { showToast("系统 " + remaining + " 秒后维护，请稍后再试", "warn"); } catch (e) {}
    }
    return false;
  };

  function _startMaintenanceBannerPoll() {
    if (_maintBanner.interval) return;
    checkMaintenanceBanner();
    _maintBanner.interval = setInterval(checkMaintenanceBanner, 10000);
  }


export { _startGlobalTaskCenterPoll, _startMaintenanceBannerPoll, _loadGlobalTaskCenter, checkMaintenanceBanner };
