/**
 * Episode management — ensure, save, load, switch, create, render tabs.
 * Extracted from main.js (stage 3-4 refactor).
 */
import { showToast, apiPostStream, escapeHtml } from './utils.js';

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
    var stepDone = ep.videoPromptsApproved;
    btn.innerHTML =
      (stepDone ? '<span class="material-symbols-outlined text-xs">check_circle</span>' : '') +
      '<span>' + escapeHtml(ep.title) + '</span>';
    btn.addEventListener("click", function () { _switchEpisode(idx); });
    wrap.appendChild(btn);
  });

  var addBtn = document.createElement("button");
  addBtn.className = "flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-bold text-primary/60 hover:text-primary hover:bg-primary/5 transition-all border border-dashed border-primary/20";
  addBtn.innerHTML = '<span class="material-symbols-outlined text-sm">add</span><span>续写新一集</span>';
  addBtn.addEventListener("click", function () { _openNewEpisodeDialog(); });
  wrap.appendChild(addBtn);
}

export function _openNewEpisodeDialog() {
  var project = _project();
  if (!project || !project.episodes) return;
  if (!project.script || !project.scriptApproved) {
    showToast("请先完成当前集的剧本再续写新一集", "warn");
    return;
  }

  var overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 backdrop-blur-sm";
  overlay.style.animation = "fadeIn .2s ease";

  var epNum = project.episodes.length + 1;
  overlay.innerHTML =
    '<div class="bg-surface-container-lowest rounded-[2rem] p-8 w-[480px] max-w-[90vw] shadow-2xl border border-white/30" onclick="event.stopPropagation()">' +
      '<h3 class="text-lg font-bold text-on-background mb-1">续写第 ' + epNum + ' 集</h3>' +
      '<p class="text-xs text-on-surface-variant mb-6">AI 将基于前集剧本和世界观生成续集，角色/场景会自动复用。</p>' +
      '<div class="mb-4">' +
        '<label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1 block">剧情方向（可选）</label>' +
        '<textarea id="newEpDirection" class="w-full bg-surface-container-low rounded-2xl p-3 text-sm text-on-surface border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none resize-none" rows="3" placeholder="例：主角发现了隐藏的真相，被迫逃离城市…（留空则 AI 自由发挥）"></textarea>' +
      '</div>' +
      '<div class="mb-6">' +
        '<label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60 mb-1 block">目标时长（可选）</label>' +
        '<input id="newEpDuration" type="text" class="w-full bg-surface-container-low rounded-xl p-2.5 text-sm text-on-surface border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none" placeholder="例：2分钟、60秒（留空则与前集一致）" />' +
      '</div>' +
      '<div class="flex gap-3">' +
        '<button type="button" id="newEpCancel" class="flex-1 py-3 rounded-full text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-all">取消</button>' +
        '<button type="button" id="newEpConfirm" class="flex-1 py-3 rounded-full text-sm font-bold text-on-primary bg-primary hover:opacity-90 transition-all shadow-lg flex items-center justify-center gap-2">' +
          '<span class="material-symbols-outlined text-sm">auto_fix_high</span>开始续写' +
        '</button>' +
      '</div>' +
      '<p id="newEpStatus" class="text-xs text-center text-on-surface-variant mt-4" hidden></p>' +
    '</div>';

  document.body.appendChild(overlay);
  overlay.addEventListener("click", function (ev) {
    if (ev.target === overlay) overlay.remove();
  });
  document.getElementById("newEpCancel").addEventListener("click", function () { overlay.remove(); });
  document.getElementById("newEpConfirm").addEventListener("click", function () {
    _createNewEpisode(overlay);
  });
}

export async function _createNewEpisode(overlay) {
  var project = _project();
  var directionEl = document.getElementById("newEpDirection");
  var durationEl = document.getElementById("newEpDuration");
  var statusEl = document.getElementById("newEpStatus");
  var confirmBtn = document.getElementById("newEpConfirm");
  var direction = directionEl ? directionEl.value.trim() : "";
  var durationStr = durationEl ? durationEl.value.trim() : "";

  if (confirmBtn) confirmBtn.disabled = true;
  if (statusEl) { statusEl.hidden = false; statusEl.textContent = "正在生成续集剧本…"; }

  _saveCurrentEpisode();

  var prevScripts = project.episodes.map(function (ep) { return ep.script || ""; });
  var existingChars = [];
  if (project.assets && project.assets.characters) {
    existingChars = project.assets.characters.map(function (c) {
      return c.name + (c.appearance ? " | " + c.appearance : "");
    });
  }

  try {
    // 前薄后厚：后端 workflow/continue 自己从 project.json 读 episodes +
    // styleBible + 现有角色，出完剧本后已经把情绪段标好（segments + title
    // 随 done 返回）。前端负责把新集推入 project.episodes[]（episode 数组
    // 是前端 UI 状态不是后端 project.json 的职责）。
    var resp = await apiPostStream("/api/script/workflow/continue", {
      projectId: project.id,
      direction: direction,
      durationSec: durationStr || project.scriptTargetDurationSec || null,
    }, null, function (evt) {
      if (evt.type === "phase" && statusEl) {
        if (evt.name === "continue_start") statusEl.textContent = "正在生成续集剧本…";
        else if (evt.name === "tag_emotions_start") statusEl.textContent = "正在标注情绪…";
      } else if (evt.type === "script_chunk" && statusEl) {
        statusEl.textContent = "正在生成续集剧本…";
      }
    });

    if (statusEl) statusEl.textContent = "剧本生成成功，正在创建分集…";

    var newEp = {
      id: "ep_" + Date.now(),
      title: resp.title || ("第 " + (project.episodes.length + 1) + " 集"),
      idea: direction || "续写自前集",
      script: resp.script,
      scriptTargetDurationSec: resp.durationSec || project.scriptTargetDurationSec,
      scriptApproved: false,
      assets: null,
      assetsApproved: false,
      shots: [],
      shotsApproved: false,
      storyboards: [],
      imagesApproved: false,
      videoPrompts: [],
      videoPromptsApproved: false,
      narrations: [],
      emotionSegments: Array.isArray(resp.emotionSegments) ? resp.emotionSegments : [],
      currentStep: 1,
    };

    project.episodes.push(newEp);
    var newIdx = project.episodes.length - 1;
    _ctx.addToScriptLibrary(newEp.title || ("第 " + (newIdx + 1) + " 集"), resp.script, "episode");
    _loadEpisode(newIdx);
    _ctx.resetProjectUI();
    _ctx.saveProject();
    _ctx.refreshAllPages();
    _ctx.restoreVideoTasks();
    _renderEpisodeTabs();
    _ctx.switchPage("script");

    overlay.remove();
    showToast("第 " + (newIdx + 1) + " 集剧本已生成！请查看并确认。", "success");
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (statusEl) statusEl.textContent = "生成失败: " + errMsg;
    if (confirmBtn) confirmBtn.disabled = false;
    showToast("续写失败: " + _ctx.diagnoseApiError(errMsg), "error");
  }
}
