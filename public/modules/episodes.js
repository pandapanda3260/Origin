/**
 * Episode management — ensure, save, load, switch, render tabs.
 * Extracted from main.js (stage 3-4 refactor).
 *
 * 2026-06-10 部—集逻辑改版（docs/series-episode-continue-plan.md）：
 * 一集 = 一个独立任务。"+续写"按钮原位保留，行为从"项目内 AI 生成续集"
 * 替换为"新建下一集任务"弹窗（继承世界观/风格模板/画幅/时长，剧本留白等用户输入）。
 * 旧的项目内 AI 自动续写接口已连路由一起摘除（拍板：写剧本是独立工作流，
 * 另行立项）。episodes[] 镜像机制保留，用于老多集项目兼容读。
 */
import { showToast, escapeHtml, getAuthHeaders } from './utils.js?v=300';
import { snapshotWorldTemplate, _normalizeWorldPreferredAspectRatio } from './assets.js?v=172';

let _ctx = {};

export function initEpisodes(ctx) {
  _ctx = ctx;
}

export function syncEpisodesProject(p) {
  // no local copy needed — always read via _ctx.getProject()
}

function _project() { return _ctx.getProject(); }
function _EPISODE_FIELDS() { return _ctx.EPISODE_FIELDS || []; }

export function _ensureEpisodes() {
  var project = _project();
  if (project && !project.episodes) {
    var ep = { id: "ep_" + Date.now(), title: "第 1 集" };
    _EPISODE_FIELDS().forEach(function (f) {
      ep[f] = project[f] !== undefined ? project[f] : null;
    });
    project.episodes = [ep];
    project.currentEpisodeIdx = 0;
    return;
  }
  if (project && project.episodes && project.emotionSegments && project.emotionSegments.length) {
    var hasAny = project.episodes.some(function (ep) {
      return ep && ep.emotionSegments && ep.emotionSegments.length;
    });
    if (!hasAny) {
      var curIdx = project.currentEpisodeIdx || 0;
      var cur = project.episodes[curIdx];
      if (cur && (!cur.emotionSegments || !cur.emotionSegments.length)) {
        cur.emotionSegments = project.emotionSegments;
        console.log('[Migration] Recovered legacy emotionSegments to episode', curIdx);
      }
    }
  }
}

export function _saveCurrentEpisode() {
  var project = _project();
  if (!project || !project.episodes) return;
  var idx = project.currentEpisodeIdx || 0;
  var ep = project.episodes[idx];
  if (!ep) return;
  _EPISODE_FIELDS().forEach(function (f) {
    ep[f] = project[f] !== undefined ? project[f] : null;
  });
}

export function _loadEpisode(idx) {
  var project = _project();
  if (!project || !project.episodes) return;
  if (idx < 0 || idx >= project.episodes.length) return;
  var ep = project.episodes[idx];
  _EPISODE_FIELDS().forEach(function (f) {
    project[f] = ep[f] !== undefined ? ep[f] : null;
  });
  project.currentEpisodeIdx = idx;
}

export function _switchEpisode(idx) {
  var project = _project();
  if (!project || !project.episodes) return;
  if (idx === project.currentEpisodeIdx) return;
  _saveCurrentEpisode();
  _loadEpisode(idx);
  _ctx.resetProjectUI();
  _ctx.saveProject();
  var autoKey = project.id + "_" + idx;
  if (project.script && !project.emotionSegments && !_ctx.emotionAutoTried[autoKey]) {
    _ctx.emotionAutoTried[autoKey] = true;
    _ctx.tagEmotions();
  }
  _ctx.refreshAllPages();
  _ctx.restoreVideoTasks();
  _renderEpisodeTabs();
  _ctx.switchPage("script");
}

export function _getCurrentEpisodeTitle() {
  var project = _project();
  if (!project || !project.episodes) return "";
  var ep = project.episodes[project.currentEpisodeIdx || 0];
  return ep ? ep.title : "";
}

export function _getPreviousEpisodeAssets() {
  var project = _project();
  if (!project || !project.episodes || project.episodes.length < 2) return null;
  var prevIdx = (project.currentEpisodeIdx || 0) - 1;
  if (prevIdx < 0) prevIdx = 0;
  var prevEp = project.episodes[prevIdx];
  return prevEp ? prevEp.assets : null;
}

/** 本任务的集号：优先部—集字段 episodeNumber（一集=一任务模型），无则视为第 1 集。 */
function _taskEpisodeNumber(project) {
  var n = Number(project && project.episodeNumber);
  if (Number.isFinite(n) && n >= 1) return Math.round(n);
  return null;
}

export function _renderEpisodeTabs() {
  var project = _project();
  var $ = _ctx.$;
  var wrap = $("episodeTabsWrap");
  if (!wrap || !project || !project.episodes) return;
  var eps = project.episodes;
  var curIdx = project.currentEpisodeIdx || 0;
  wrap.innerHTML = "";

  eps.forEach(function (ep, idx) {
    var btn = document.createElement("button");
    btn.className = idx === curIdx
      ? "flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-bold bg-primary text-on-primary shadow-sm transition-all"
      : "flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-bold text-on-surface-variant hover:bg-surface-container transition-all";
    // 一集=一任务的新模型：单集任务的标签显示部—集字段里的集号（"第 N 集"）。
    // 老多集项目（episodes>1）沿用各自原标题，不做兼容改写。
    var label = ep.title;
    var taskEpNum = _taskEpisodeNumber(project);
    if (eps.length === 1 && taskEpNum) label = "第 " + taskEpNum + " 集";
    btn.innerHTML = '<span>' + escapeHtml(label) + '</span>';
    btn.addEventListener("click", function () { _switchEpisode(idx); });
    wrap.appendChild(btn);
  });

  var addBtn = document.createElement("button");
  addBtn.className = "flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-bold text-primary/60 hover:text-primary hover:bg-primary/5 transition-all border border-dashed border-primary/20";
  addBtn.innerHTML = '<span class="material-symbols-outlined text-sm">add</span><span>续写</span>';
  addBtn.addEventListener("click", function () { _openNewEpisodeDialog(); });
  wrap.appendChild(addBtn);
}

/* ================================================================
   续写下一集 = 新建独立任务（docs/series-episode-continue-plan.md §7）
   ================================================================ */

var _continueInFlight = false;

function _stripEpisodeSuffix(name) {
  return String(name || "").replace(/\s*第\s*\d+\s*集\s*$/, "").trim();
}

/** 拉任务列表，按 seriesId 计算下一集集号：max(episodeNumber)+1，删中间集不补号。 */
async function _computeNextEpisodeNumber(project) {
  var sid = project.seriesId || project.id;
  var maxNum = _taskEpisodeNumber(project) || 1;
  try {
    var resp = await fetch("/api/projects", { headers: getAuthHeaders() });
    if (resp.ok) {
      var body = await resp.json().catch(function () { return {}; });
      var items = (body && (body.projects || body.items)) || [];
      items.forEach(function (p) {
        if (!p) return;
        var inSeries = (p.seriesId && p.seriesId === sid) || p.id === sid;
        if (!inSeries) return;
        var n = Number(p.episodeNumber);
        if (Number.isFinite(n) && n > maxNum) maxNum = Math.round(n);
      });
    }
  } catch (_) { /* 列表拉取失败时退化为本地 episodeNumber+1 */ }
  return { seriesId: sid, nextNumber: maxNum + 1 };
}

async function _fetchWorldTemplateOptions() {
  var resp = await fetch("/api/world-templates", { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error("世界观模板列表加载失败 (" + resp.status + ")");
  var body = await resp.json().catch(function () { return {}; });
  return (body && (body.templates || body.items)) || [];
}

async function _fetchFullWorldTemplate(tplId) {
  var resp = await fetch("/api/world-templates/" + encodeURIComponent(tplId), { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error("世界观模板加载失败 (" + resp.status + ")");
  var body = await resp.json().catch(function () { return {}; });
  if (!body || !body.template) throw new Error("世界观模板数据为空");
  return body.template;
}

export function _openNewEpisodeDialog() {
  var project = _project();
  if (!project || !project.id) {
    showToast("请先打开一个任务再续写", "warn");
    return;
  }

  var overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm";
  overlay.style.animation = "fadeIn .2s ease";

  var baseName = _stripEpisodeSuffix(project.name || project.title || "未命名剧");
  var curNum = _taskEpisodeNumber(project) || 1;
  var guessNum = curNum + 1; // 先用本地猜测渲染，异步算准后回填
  var hasWorld = !!(project.selectedWorldTemplateId || (project.worldTemplateSnapshot && project.worldTemplateSnapshot.id));
  var currentWorldId = String(project.selectedWorldTemplateId || (project.worldTemplateSnapshot && project.worldTemplateSnapshot.id) || "");
  // 可无视的被动提示（不硬拦）：当前集剧本还没确认也允许续写
  var softHint = (!project.script || !project.scriptApproved)
    ? '<p class="text-[11px] text-on-surface-variant/70 mb-3">提示：当前集剧本尚未确认，仍可先创建下一集任务。</p>'
    : '';

  overlay.innerHTML =
    '<div class="bg-surface-container-lowest rounded-[2rem] p-8 w-[480px] max-w-[90vw] shadow-2xl border border-white/30" onclick="event.stopPropagation()">' +
      '<div class="flex items-center justify-between mb-1">' +
        '<h3 class="text-lg font-bold text-on-background">续写下一集</h3>' +
        '<button type="button" id="ceClose" class="text-on-surface-variant hover:text-primary transition-all" title="关闭">' +
          '<span class="material-symbols-outlined">close</span>' +
        '</button>' +
      '</div>' +
      '<p class="text-xs text-on-surface-variant mb-4">基于《' + escapeHtml(baseName) + '》创建 <span id="ceEpNumText">第 ' + guessNum + ' 集</span> 的新任务，剧本由你在新任务中输入。</p>' +
      softHint +
      '<div class="mb-4">' +
        '<label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1 block">任务名称</label>' +
        '<input id="ceName" type="text" class="w-full bg-surface-container-low rounded-xl p-2.5 text-sm text-on-surface border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none" />' +
      '</div>' +
      '<div class="mb-6 space-y-2">' +
        '<label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1 block">世界观</label>' +
        '<label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer">' +
          '<input type="radio" name="ceMode" value="blank"' + (hasWorld ? '' : ' checked') + ' />新建空白任务' +
        '</label>' +
        '<label class="flex items-center gap-2 text-sm text-on-surface cursor-pointer">' +
          '<input type="radio" name="ceMode" value="template"' + (hasWorld ? ' checked' : '') + ' />选择世界观模板' +
        '</label>' +
        '<select id="ceWorldSelect" class="w-full bg-surface-container-low rounded-xl p-2.5 text-sm text-on-surface border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none">' +
          '<option value="">加载中…</option>' +
        '</select>' +
      '</div>' +
      '<div class="flex gap-3">' +
        '<button type="button" id="ceCancel" class="flex-1 py-3 rounded-full text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-all">取消</button>' +
        '<button type="button" id="ceConfirm" class="flex-1 py-3 rounded-full text-sm font-bold text-on-primary bg-primary hover:opacity-90 transition-all shadow-lg flex items-center justify-center gap-2">' +
          '<span class="material-symbols-outlined text-sm">add</span>确认' +
        '</button>' +
      '</div>' +
      '<p id="ceStatus" class="text-xs text-center text-on-surface-variant mt-4" hidden></p>' +
    '</div>';

  document.body.appendChild(overlay);

  var nameInput = overlay.querySelector("#ceName");
  var selectEl = overlay.querySelector("#ceWorldSelect");
  var epNumText = overlay.querySelector("#ceEpNumText");
  var state = { seriesId: project.seriesId || project.id, nextNumber: guessNum, nameDirty: false };

  nameInput.value = baseName + " 第" + guessNum + "集";
  nameInput.addEventListener("input", function () { state.nameDirty = true; });

  function syncSelectEnabled() {
    var mode = overlay.querySelector('input[name="ceMode"]:checked');
    var useTpl = mode && mode.value === "template";
    selectEl.disabled = !useTpl;
    selectEl.classList.toggle("opacity-60", !useTpl);
    selectEl.classList.toggle("pointer-events-none", !useTpl);
  }
  overlay.querySelectorAll('input[name="ceMode"]').forEach(function (r) {
    r.addEventListener("change", syncSelectEnabled);
  });
  syncSelectEnabled();

  // 异步：算准集号（按 seriesId 扫任务列表）+ 拉世界观模板下拉
  _computeNextEpisodeNumber(project).then(function (res) {
    if (!overlay.isConnected) return;
    state.seriesId = res.seriesId;
    state.nextNumber = res.nextNumber;
    if (epNumText) epNumText.textContent = "第 " + res.nextNumber + " 集";
    if (!state.nameDirty) nameInput.value = baseName + " 第" + res.nextNumber + "集";
  });
  _fetchWorldTemplateOptions().then(function (templates) {
    if (!overlay.isConnected) return;
    if (!templates.length) {
      selectEl.innerHTML = '<option value="">（暂无世界观模板）</option>';
      var blankRadio = overlay.querySelector('input[name="ceMode"][value="blank"]');
      if (blankRadio && !overlay.querySelector('input[name="ceMode"][value="template"]:checked')) blankRadio.checked = true;
      syncSelectEnabled();
      return;
    }
    selectEl.innerHTML = templates.map(function (tpl) {
      var id = escapeHtml(String(tpl.id || ""));
      var name = escapeHtml(String(tpl.name || tpl.id || "未命名模板"));
      var sel = currentWorldId && String(tpl.id) === currentWorldId ? " selected" : "";
      return '<option value="' + id + '"' + sel + '>' + name + '</option>';
    }).join("");
  }).catch(function (e) {
    if (!overlay.isConnected) return;
    selectEl.innerHTML = '<option value="">（模板列表加载失败）</option>';
    showToast(((e && e.message) || e).toString(), "warn");
  });

  function close() { overlay.remove(); }
  overlay.addEventListener("click", function (ev) { if (ev.target === overlay) close(); });
  overlay.querySelector("#ceClose").addEventListener("click", close);
  overlay.querySelector("#ceCancel").addEventListener("click", close);
  overlay.querySelector("#ceConfirm").addEventListener("click", function () {
    _confirmContinueEpisode(overlay, state, baseName);
  });
}

async function _confirmContinueEpisode(overlay, state, baseName) {
  if (_continueInFlight) return;
  var project = _project();
  if (!project || !project.id) { overlay.remove(); return; }

  var nameInput = overlay.querySelector("#ceName");
  var selectEl = overlay.querySelector("#ceWorldSelect");
  var statusEl = overlay.querySelector("#ceStatus");
  var confirmBtn = overlay.querySelector("#ceConfirm");
  var mode = overlay.querySelector('input[name="ceMode"]:checked');
  var useTemplate = mode && mode.value === "template";
  var tplId = useTemplate && selectEl ? String(selectEl.value || "").trim() : "";
  if (useTemplate && !tplId) {
    showToast("请选择一个世界观模板，或改为新建空白任务", "warn");
    return;
  }
  var name = (nameInput && nameInput.value.trim()) || (baseName + " 第" + state.nextNumber + "集");

  _continueInFlight = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (statusEl) { statusEl.hidden = false; statusEl.textContent = "正在创建第 " + state.nextNumber + " 集任务…"; }

  var sourceId = project.id;
  var sourceHasSeries = !!project.seriesId;

  try {
    // 1) 组创建 payload：继承画幅/时长/风格模板（上一集实际值优先，方案 §6.4），剧本留白
    var payload = {
      id: "proj_" + Date.now(),
      clientRequestId: _ctx.newClientRequestId ? _ctx.newClientRequestId() : ("cr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10)),
      name: name,
      currentStep: 1,
      scriptTargetDurationSec: project.scriptTargetDurationSec || null,
      selectedStyleTemplateId: project.selectedStyleTemplateId || null,
      styleTemplateSnapshot: project.styleTemplateSnapshot ? JSON.parse(JSON.stringify(project.styleTemplateSnapshot)) : null,
      seriesId: state.seriesId,
      episodeNumber: state.nextNumber,
      prevProjectId: sourceId,
      episodes: [{ title: "第 " + state.nextNumber + " 集" }],
    };
    // 带上 aspectRatioDefaultVersion：服务端 normalizeProjectStyleDefaults 对没有
    // 该标记的项目会把 16:9 当旧默认翻回 9:16（一次性迁移），不带标记会把继承/
    // 模板记录的 16:9 冲掉。常量与 lib/projects-db.ts STYLE_ASPECT_DEFAULT_VERSION
    // 及 main.js _STYLE_ASPECT_DEFAULT_VERSION 同源。
    var _EP_ASPECT_DEFAULT_VERSION = "2026-05-14-9x16";
    var prevStyleOpts = (project.styleOptions && typeof project.styleOptions === "object") ? project.styleOptions : {};
    var aspect = prevStyleOpts.aspectRatio;
    if (aspect) {
      payload.styleOptions = {
        aspectRatio: aspect,
        aspectRatioDefaultVersion: prevStyleOpts.aspectRatioDefaultVersion || _EP_ASPECT_DEFAULT_VERSION,
      };
    }

    // 2) 世界观：拉全量模板 → 与风格页同款快照语义（snapshotWorldTemplate 剥离 styleBible）
    if (useTemplate) {
      if (statusEl) statusEl.textContent = "正在载入世界观模板…";
      var fullTpl = await _fetchFullWorldTemplate(tplId);
      var snap = snapshotWorldTemplate(fullTpl);
      payload.selectedWorldTemplateId = snap.id || tplId;
      payload.worldTemplateSnapshot = snap;
      // 世界观记录的画面比例优先于上一集继承（与应用世界观自动同步风格同款语义）
      var tplAspect = _normalizeWorldPreferredAspectRatio(
        snap.preferredAspectRatio || snap.preferred_aspect_ratio
      );
      if (tplAspect) {
        payload.styleOptions = {
          aspectRatio: tplAspect,
          aspectRatioDefaultVersion: prevStyleOpts.aspectRatioDefaultVersion || _EP_ASPECT_DEFAULT_VERSION,
        };
      }
      if (statusEl) statusEl.textContent = "正在创建第 " + state.nextNumber + " 集任务…";
    }

    // 3) 创建（后端按会员档做配额权威拦截，409 project_quota_exceeded）
    var resp = await fetch("/api/projects", {
      method: "POST",
      headers: Object.assign({}, getAuthHeaders(), { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (resp.status === 409) {
      var err = await resp.json().catch(function () { return {}; });
      if (err && err.error === "project_quota_exceeded") {
        throw new Error(err.detail || ("任务数已达上限 " + (err.max || "") + "，删除旧任务或升级会员后可继续创建"));
      }
      throw new Error((err && (err.detail || err.error)) || "创建冲突 (409)");
    }
    if (!resp.ok) {
      var errBody = await resp.json().catch(function () { return {}; });
      throw new Error((errBody && (errBody.detail || errBody.error)) || ("创建失败 (" + resp.status + ")"));
    }
    var serverProj = await resp.json();
    if (!serverProj || !serverProj.id) throw new Error("后端没有返回新任务数据");

    // 4) 回填源任务的部—集字段（首次续写：seriesId=自身 id、episodeNumber=1）。
    //    best-effort：失败不阻断主流程（新任务自带 seriesId，分组仍成立）。
    if (!sourceHasSeries) {
      try {
        var putResp = await fetch("/api/projects/" + encodeURIComponent(sourceId), {
          method: "PUT",
          headers: Object.assign({}, getAuthHeaders(), { "Content-Type": "application/json" }),
          body: JSON.stringify({ seriesId: state.seriesId, episodeNumber: _taskEpisodeNumber(project) || 1 }),
        });
        if (putResp.ok) {
          var updated = await putResp.json().catch(function () { return null; });
          var cur = _project();
          if (updated && cur && cur.id === sourceId) {
            cur.seriesId = updated.seriesId || state.seriesId;
            cur.episodeNumber = updated.episodeNumber || 1;
            if (updated.version) cur.version = updated.version;
          }
        } else {
          console.warn("[continueEpisode] 源任务回填 seriesId 失败:", putResp.status);
        }
      } catch (e) {
        console.warn("[continueEpisode] 源任务回填 seriesId 异常:", e);
      }
    }

    // 5) 统一收尾（与新建任务同一条路径）→ 落到空白剧本页
    if (statusEl) statusEl.textContent = "任务已创建，正在打开…";
    var ok = _ctx.finalizeCreatedProject ? await _ctx.finalizeCreatedProject(serverProj) : false;
    overlay.remove();
    if (ok) {
      _ctx.switchPage("script");
      showToast("第 " + state.nextNumber + " 集任务已创建" + (useTemplate ? "，世界观已带入" : "") + "，请输入剧本。", "success");
    }
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 160);
    if (statusEl) statusEl.textContent = "创建失败: " + errMsg;
    if (confirmBtn) confirmBtn.disabled = false;
    showToast("续写失败: " + (_ctx.diagnoseApiError ? _ctx.diagnoseApiError(errMsg) : errMsg), "error");
  } finally {
    _continueInFlight = false;
  }
}
