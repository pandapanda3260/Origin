import { $, escapeHtml, showToast, apiPost, apiGet, getAuthHeaders } from './utils.js';
import { subscribeBatch } from './backend_stream.js';

let _ctx = {};
let project = null;

const SHOT_TYPES = [
  "大全景","远景","全景","中景","中近景","近景","特写","大特写",
  "俯拍","仰拍","主观镜头","过肩镜头"
];
const CAMERA_MOVES = [
  "固定镜头",
  "缓慢推进","轻微推近","推近","快速推进",
  "缓慢拉远","拉远","快速拉远",
  "左移","右移","上移","下移",
  "跟随","环绕","摇镜头","手持轻晃","升降","甩镜头"
];

var _shotParaMap = {};
var _scriptParas = [];
var _shotHoverBound = false;

export function initShots(ctx) {
  _ctx = ctx || {};
  _syncRefs();
}

export function syncShotsProject(p) {
  project = p || null;
  _shotHoverBound = false;
}

function _syncRefs() {
  project = _ctx.getProject ? _ctx.getProject() : project;
}

function saveProject() { if (_ctx.saveProject) return _ctx.saveProject(); }
function _safeWriteBack(id, fn, serverVersion) { return _ctx.safeWriteBack ? _ctx.safeWriteBack(id, fn, serverVersion) : false; }
function switchPage(p) { if (_ctx.switchPage) _ctx.switchPage(p); }
function formatCreatorProfileForApi() { return _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null; }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function _markDownstreamStale(scope, detail) { if (_ctx.markDownstreamStale) _ctx.markDownstreamStale(scope, detail); }
function _isStale(key) { return _ctx.isStale ? _ctx.isStale(key) : false; }
function agentInsertRef(type, label, data) { if (_ctx.agentInsertRef) _ctx.agentInsertRef(type, label, data); }
function emotionBadgeHtml(emotion, intensity) { return _ctx.emotionBadgeHtml ? _ctx.emotionBadgeHtml(emotion, intensity) : ''; }

/* ================================================================
   Shots page
   ================================================================ */
export function refreshShotsPage() {
  _syncRefs();
  var needScript = $("shotsNeedScript");
  var ready = $("shotsReady");
  if (!project || !project.assetsApproved) {
    if (needScript) needScript.hidden = false;
    if (ready) ready.hidden = true;
    var wrap = $("shotListWrap");
    if (wrap) wrap.innerHTML = "";
    var ca = $("shotsConfirmArea");
    if (ca) ca.hidden = true;
    return;
  }
  needScript.hidden = true;
  ready.hidden = false;
  renderShotList();
}

function _buildSelectOptions(options, current) {
  var html = '<option value="">—</option>';
  var matched = false;
  options.forEach(function (opt) {
    var sel = (current === opt) ? ' selected' : '';
    if (current === opt) matched = true;
    html += '<option value="' + escapeHtml(opt) + '"' + sel + '>' + escapeHtml(opt) + '</option>';
  });
  if (current && !matched) {
    html += '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + '</option>';
  }
  return html;
}

export function renderShotList() {
  _syncRefs();
  var wrap = $("shotListWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!project || !project.shots || !project.shots.length) {
    var ca = $("shotsConfirmArea"); if (ca) ca.hidden = true;
    return;
  }

  var hasShotStale = project.shots.some(function (_, si) { return _isStale("shot_" + si); });
  if (hasShotStale) {
    var _ssb = document.createElement("div");
    _ssb.className = "upstream-stale-banner mx-8";
    _ssb.innerHTML = '<span class="material-symbols-outlined">warning</span>剧本/资产已修改，分镜可能需要重新生成以保持一致性';
    wrap.appendChild(_ssb);
  }

  var totalSec = 0;
  project.shots.forEach(function (s) { totalSec += (s.duration || 4); });
  var summaryDiv = document.createElement("div");
  summaryDiv.className = "text-sm text-on-surface-variant mb-6 px-8";
  summaryDiv.textContent = "共 " + project.shots.length + " 个镜头 · 总时长约 " + totalSec + " 秒";
  wrap.appendChild(summaryDiv);

  project.shots.forEach(function (shot, idx) {
    var card = document.createElement("div");
    card.className = "sc-card group bg-surface-container-low/40 p-6 rounded-xl border border-outline-variant/10 hover:bg-surface-container-lowest transition-all duration-300 hover:shadow-lg";
    card.dataset.shotIdx = idx;

    card.innerHTML =
      '<div class="flex items-center justify-between mb-4">' +
        '<div class="flex items-center gap-3">' +
          '<span class="text-2xl font-thin text-primary-dim/50">' + String(idx+1).padStart(2,'0') + '</span>' +
          '<span class="bg-surface-container-highest px-3 py-1 rounded-lg text-[10px] font-bold text-on-tertiary-container">' + (shot.duration||4) + 's</span>' +
          (shot.emotion ? '<span class="shot-emotion-tag">' + emotionBadgeHtml(shot.emotion, shot.intensity) + '</span>' : '') +
        '</div>' +
        '<button type="button" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-primary/10 transition-colors" data-action="ref-agent" title="引用到 AI 助手">' +
          '<span class="material-symbols-outlined text-sm text-[#90A4AE] hover:text-primary">alternate_email</span>' +
        '</button>' +
        '<button type="button" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-red-500/10 transition-colors" data-action="delete-shot" title="删除镜头">' +
          '<span class="material-symbols-outlined text-sm text-[#90A4AE] hover:text-red-500">delete_outline</span>' +
        '</button>' +
      '</div>' +
      '<div class="grid grid-cols-2 gap-3 mb-4">' +
        '<div>' +
          '<label class="text-[10px] font-bold text-[#90A4AE] uppercase tracking-widest mb-1 block">景别</label>' +
          '<select class="shot-field w-full bg-surface-container-highest/60 text-xs font-bold text-on-surface rounded-lg px-3 py-2 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none cursor-pointer" data-field="shotType">' +
            _buildSelectOptions(SHOT_TYPES, shot.shotType || "") +
          '</select>' +
        '</div>' +
        '<div>' +
          '<label class="text-[10px] font-bold text-[#90A4AE] uppercase tracking-widest mb-1 block">运镜</label>' +
          '<select class="shot-field w-full bg-surface-container-highest/60 text-xs font-bold text-on-surface rounded-lg px-3 py-2 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none cursor-pointer" data-field="camera">' +
            _buildSelectOptions(CAMERA_MOVES, shot.camera || "") +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="mb-3">' +
        '<label class="text-[10px] font-bold text-[#90A4AE] uppercase tracking-widest mb-1 block">画面描述</label>' +
        '<textarea class="shot-field w-full bg-transparent text-sm font-light text-on-surface rounded-lg px-3 py-2 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none resize-none leading-relaxed transition-colors hover:border-primary/20" data-field="visual" rows="3" placeholder="画面内容">' + escapeHtml(shot.visual||"") + '</textarea>' +
      '</div>' +
      '<div class="mb-3">' +
        '<label class="text-[10px] font-bold text-[#90A4AE] uppercase tracking-widest mb-1 block">对白/旁白</label>' +
        '<textarea class="shot-field w-full bg-transparent text-sm font-light text-on-surface rounded-lg px-3 py-2 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none resize-none leading-relaxed transition-colors hover:border-primary/20" data-field="dialogue" rows="2" placeholder="对白或旁白">' + escapeHtml(shot.dialogue||"") + '</textarea>' +
      '</div>' +
      '<div class="mb-3">' +
        '<label class="text-[10px] font-bold text-[#90A4AE] uppercase tracking-widest mb-1 block">关键信息</label>' +
        '<input type="text" class="shot-field w-full bg-transparent text-sm font-light text-on-surface rounded-lg px-3 py-2 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none" data-field="keyInfo" value="' + escapeHtml(shot.keyInfo||"") + '" placeholder="情绪/道具/特效等" />' +
      '</div>' +
      '<input type="hidden" data-field="audio" value="' + escapeHtml(shot.audio||"") + '" />';
    wrap.appendChild(card);
  });

  wrap.querySelectorAll(".shot-field").forEach(function (el) {
    var evt = (el.tagName === "SELECT") ? "change" : "blur";
    el.addEventListener(evt, function () {
      var card = el.closest(".sc-card[data-shot-idx]");
      if (!card) return;
      var idx = parseInt(card.dataset.shotIdx, 10);
      if (isNaN(idx) || !project || !project.shots[idx]) return;
      var field = el.dataset.field;
      var val = el.value.trim();
      if (project.shots[idx][field] !== val) {
        project.shots[idx][field] = val;
        _markDownstreamStale("shot", { idx: idx });
        saveProject();
      }
    });
  });

  var ca2 = $("shotsConfirmArea"); if (ca2) ca2.hidden = false;
  _renderScriptRefPanel();
  _shotParaMap = _buildShotScriptMapping();
  _bindShotHoverHighlight();
}

function _renderScriptRefPanel() {
  var colWrap = $("scriptRefColWrap");
  var panel = $("scriptRefPanel");
  if (!colWrap || !panel) return;
  if (!project || !project.script || !project.shots || !project.shots.length) {
    colWrap.hidden = true; return;
  }
  var raw = project.script.replace(/\r\n/g, "\n");
  _scriptParas = raw.split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (!_scriptParas.length) {
    _scriptParas = raw.split(/\n/).map(function (p) { return p.trim(); }).filter(Boolean);
  }
  var html = "";
  _scriptParas.forEach(function (text, i) {
    html += '<div class="sr-para" data-para-idx="' + i + '">' + escapeHtml(text) + '</div>';
  });
  panel.innerHTML = html;
  colWrap.hidden = false;
}

function _buildShotScriptMapping() {
  var map = {};
  if (!project || !project.shots || !_scriptParas.length) return map;
  var fullScript = project.script || "";
  project.shots.forEach(function (shot, si) {
    map[si] = [];
    if (shot.scriptRef && shot.scriptRef.trim()) {
      var ref = shot.scriptRef.trim();
      var charStart = fullScript.indexOf(ref);
      if (charStart >= 0) {
        var runLen = 0;
        for (var pi = 0; pi < _scriptParas.length; pi++) {
          var pStart = fullScript.indexOf(_scriptParas[pi], runLen);
          if (pStart < 0) continue;
          var pEnd = pStart + _scriptParas[pi].length;
          var refEnd = charStart + ref.length;
          if (charStart < pEnd && refEnd > pStart) map[si].push(pi);
          runLen = pStart + 1;
        }
      }
      if (map[si].length) return;
    }
    var keywords = [];
    if (shot.dialogue) {
      var raw = shot.dialogue.replace(/^[^：:]+[：:]\s*/, "").trim();
      if (raw.length >= 4) keywords.push(raw);
    }
    if (shot.visual) {
      (shot.characters || []).forEach(function (c) { if (c) keywords.push(c); });
    }
    if (keywords.length) {
      _scriptParas.forEach(function (pText, pi) {
        for (var k = 0; k < keywords.length; k++) {
          if (pText.indexOf(keywords[k]) >= 0) {
            if (map[si].indexOf(pi) < 0) map[si].push(pi);
            break;
          }
        }
      });
    }
  });
  return map;
}

function _bindShotHoverHighlight() {
  if (_shotHoverBound) return;
  var wrap = $("shotListWrap");
  var panelBody = $("scriptRefPanel");
  if (!wrap || !panelBody) return;
  _shotHoverBound = true;
  var _lastHighlightIdx = -1;

  wrap.addEventListener("mouseover", function (e) {
    var card = e.target.closest(".sc-card[data-shot-idx]");
    if (!card) return;
    var idx = parseInt(card.dataset.shotIdx, 10);
    if (isNaN(idx) || idx === _lastHighlightIdx) return;
    _lastHighlightIdx = idx;
    var allParas = panelBody.querySelectorAll(".sr-para");
    if (!allParas.length) return;
    var matched = _shotParaMap[idx] || [];
    var hasDim = matched.length > 0;
    allParas.forEach(function (p) {
      p.classList.remove("script-ref-active", "script-ref-dim");
      if (hasDim) p.classList.add("script-ref-dim");
    });
    matched.forEach(function (pi) {
      if (allParas[pi]) {
        allParas[pi].classList.remove("script-ref-dim");
        allParas[pi].classList.add("script-ref-active");
      }
    });
    if (matched.length && allParas[matched[0]]) {
      var scrollWrap = panelBody.closest('.shots-right-col') || panelBody;
      var paraEl = allParas[matched[0]];
      var wrapRect = scrollWrap.getBoundingClientRect();
      var paraRect = paraEl.getBoundingClientRect();
      var target = scrollWrap.scrollTop + (paraRect.top - wrapRect.top) - (wrapRect.height - paraRect.height) / 2;
      scrollWrap.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  });

  wrap.addEventListener("mouseleave", function () {
    _lastHighlightIdx = -1;
    panelBody.querySelectorAll(".sr-para").forEach(function (p) {
      p.classList.remove("script-ref-active", "script-ref-dim");
    });
  });
}

function _setShotsProgress(pct, title, hint) {
  var bar = $("shotsGenProgress");
  var banner = $("shotsGenBanner");
  var titleEl = $("shotsGenTitle");
  var hintEl = $("shotsGenHint");
  if (bar) bar.style.width = pct + "%";
  if (banner) banner.hidden = false;
  if (titleEl && title) titleEl.textContent = title;
  if (hintEl && hint) hintEl.textContent = hint;
}

/* ----------------------------------------------------------------
   generateShots — Phase 5.13 (batch_runner 后端化)
   ================================================================
   从 apiPostStream("/api/shots/generate") 换成 POST /api/batch/start
   {batchType:"shots"} + subscribeBatch。后端 shots_executor 负责真正的
   LLM 调用，前端只看阶段性进度 + 最终 patch。

   好处：
   - 刷新 / 切 tab / 关 tab 重开都不丢状态（main.js 的 reattachActiveBatches
     识别 shots 就能重新挂 SSE）
   - reasoning 阶段通过后端 REASONING_BEAT 心跳保持连接活跃，不再 90 秒
     掐线
   - 成功后 `services.project_patch` 直接权威落盘 `project.shots`，前端
     `_safeWriteBack` 只是 UI 乐观更新
   ---------------------------------------------------------------- */
export async function generateShots(opts) {
  _syncRefs();
  var existingBatchId = (opts && opts.resumeBatchId) || null;

  if (!existingBatchId) {
    if (!project || !project.assetsApproved) {
      showToast("请先完成资产库确认", "warn");
      return;
    }
  }

  var originId = project.id;
  var btn = $("btnGenShots");
  if (btn) btn.disabled = true;
  _setShotsProgress(5, "AI 正在分析剧本与资产…", "准备生成完整镜头表，请稍候");
  var _progressBar = $("shotsGenProgress");
  if (_progressBar) _progressBar.classList.add("extract-bar-pulse");

  var batchId = existingBatchId;
  if (!batchId) {
    try {
      var startResp = await apiPost("/api/batch/start", {
        batchType: "shots",
        projectId: originId,
        targets: [{ type: "shots" }],
        options: {
          script: project.script,
          styleBible: project.styleBible,
          assets: project.assets,
          idea: project.idea || "",
          durationSec: project.scriptTargetDurationSec || null,
          emotionSegments: project.emotionSegments || [],
          creatorProfile: formatCreatorProfileForApi(),
        },
      });
      batchId = startResp && startResp.batchId;
      if (!batchId) throw new Error("启动失败：未返回 batchId");
    } catch (e) {
      if (_progressBar) _progressBar.classList.remove("extract-bar-pulse");
      var errTextStart = ((e && e.message) || e).toString().slice(0, 150);
      _setShotsProgress(0, "镜头设计失败", errTextStart);
      showToast("镜头设计启动失败：" + _diagnoseApiError(errTextStart), "error");
      if (btn) btn.disabled = false;
      return;
    }
  } else {
    _setShotsProgress(15, "重新连接生成任务…", "已检测到后台正在生成，继续跟踪进度");
  }

  var finished = false;
  var pollTimer = null;
  function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function finish() {
    if (finished) return;
    finished = true;
    _stopPoll();
    if (_progressBar) _progressBar.classList.remove("extract-bar-pulse");
    if (btn) btn.disabled = false;
  }

  // 兜底轮询：每 5 秒主动 GET /api/batch/<id> 拿权威状态。
  // SSE 在某些环境下不稳定（开发热重载、浏览器节流、反代 buffer 等），
  // 轮询保证不管 SSE 通不通，UI 最终一定追得上。
  // 检测到 status=completed → 从服务端整包重拉项目（shots 已经被
  // executor 落盘）+ 触发渲染；status=failed → 显示错误提示。
  async function _pollOnce() {
    if (finished) return;
    try {
      var snap = await apiGet("/api/batch/" + encodeURIComponent(batchId));
      if (!snap || finished) return;
      if (snap.status === "completed") {
        console.log("[Shots] poll detected batch completed → reload project");
        try {
          var resp = await fetch("/api/projects/" + encodeURIComponent(originId), { headers: getAuthHeaders() });
          if (resp.ok) {
            var p = await resp.json();
            if (p && p.id === originId && Array.isArray(p.shots)) {
              _safeWriteBack(originId, function (proj) {
                proj.shots = p.shots;
                proj.shotsApproved = !!p.shotsApproved;
                if (proj._staleFlags) {
                  Object.keys(proj._staleFlags).forEach(function (k) {
                    if (k.indexOf("shot_") === 0 || k.indexOf("storyboard_") === 0 || k.indexOf("video_prompt_") === 0) {
                      delete proj._staleFlags[k];
                    }
                  });
                }
              });
              _setShotsProgress(100, "镜头设计完成", "共生成 " + p.shots.length + " 个镜头");
              setTimeout(function () { var b = $("shotsGenBanner"); if (b) b.hidden = true; }, 2000);
              renderShotList();
              showToast("镜头设计完成：共 " + p.shots.length + " 个镜头", "success");
            }
          }
        } catch (e) { console.warn("[Shots] reload after poll failed:", e); }
        finish();
      } else if (snap.status === "failed" || snap.status === "cancelled") {
        var taskErr = "";
        if (Array.isArray(snap.tasks)) {
          var f = snap.tasks.find(function (t) { return t.status === "failed"; });
          if (f && f.errorMsg) taskErr = f.errorMsg;
        }
        var failMsg = taskErr || "请稍后重试";
        console.warn("[Shots] poll detected batch failed: " + failMsg);
        _setShotsProgress(0, "镜头设计失败", failMsg.slice(0, 120));
        showToast("镜头设计失败：" + _diagnoseApiError(failMsg), "error");
        finish();
      }
    } catch (e) {
      console.warn("[Shots] poll failed:", (e && e.message) || e);
    }
  }
  pollTimer = setInterval(_pollOnce, 5000);

  subscribeBatch(batchId, {
    onSnapshot: function (snap) {
      if (snap && snap.succeeded >= 1) {
        _setShotsProgress(95, "生成完成，正在落盘…", "");
      } else if (snap && snap.failed >= 1) {
        _setShotsProgress(0, "镜头设计失败", "请稍后重试");
      } else {
        _setShotsProgress(20, "AI 正在生成镜头表", "已连接后台任务");
      }
    },
    onTaskStarted: function () {
      _setShotsProgress(20, "AI 正在生成镜头表", "请耐心等待，推理类模型可能需要 1~3 分钟");
    },
    onTaskProgress: function (data) {
      if (!data || !data.stage) return;
      var stage = data.stage;

      if (stage === "prepare") {
        _setShotsProgress(Math.max(10, data.percent || 10), "正在准备素材", data.hint || "");
      } else if (stage === "planning") {
        _setShotsProgress(Math.max(10, data.percent || 10), "AI 正在分析剧本结构", data.hint || "规划场次与分组…");
      } else if (stage === "dispatching") {
        _setShotsProgress(Math.max(20, data.percent || 20), "正在分配镜头任务", data.hint || "");
      } else if (stage.indexOf("scene_") === 0) {
        _setShotsProgress(Math.max(25, data.percent || 25), "正在生成镜头", data.hint || "");
      } else if (stage.indexOf("flushed_") === 0) {
        _setShotsProgress(Math.max(30, data.percent || 30), "镜头生成中", data.hint || "");
        var partial = data.partialShots;
        if (Array.isArray(partial) && partial.length) {
          _safeWriteBack(originId, function (proj) {
            proj.shots = partial;
          });
          renderShotList();
        }
      } else if (stage === "assembling") {
        _setShotsProgress(Math.max(88, data.percent || 88), "正在组装最终镜头表", data.hint || "");
      } else if (stage === "reasoning") {
        var base = 25;
        var step = Math.min(35, (data.beatCount || 1) * 2);
        _setShotsProgress(base + step, "AI 正在深度推理", data.hint || "AI 正在深度推理…");
      } else if (stage === "writing") {
        _setShotsProgress(Math.max(70, data.percent || 70), "AI 正在输出镜头表", data.hint || "");
      } else if (stage === "parsing") {
        _setShotsProgress(Math.max(90, data.percent || 90), "整理中", data.hint || "正在整理镜头表");
      }
    },
    onTaskCompleted: function (data) {
      var patch = (data && data.patch) || {};
      var arr = Array.isArray(patch.value) ? patch.value : null;
      if (!arr || !arr.length) {
        _setShotsProgress(0, "镜头设计失败", "AI 未返回有效镜头表");
        showToast("镜头设计失败：未能解析出分镜列表", "error");
        return;
      }

      var isCurrent = _safeWriteBack(originId, function (proj) {
        proj.shots = arr;
        proj.shotsApproved = false;
        proj.storyboards = [];
        if (proj._staleFlags) {
          Object.keys(proj._staleFlags).forEach(function (k) {
            if (k.indexOf("shot_") === 0 || k.indexOf("storyboard_") === 0 || k.indexOf("video_prompt_") === 0) {
              delete proj._staleFlags[k];
            }
          });
        }
      }, data && data.serverVersion);

      _setShotsProgress(100, "镜头设计完成", "共生成 " + arr.length + " 个镜头");
      if (isCurrent) {
        var _types = {};
        arr.forEach(function (sh) {
          var t = sh.shotType || "其他";
          _types[t] = (_types[t] || 0) + 1;
        });
        showToast(
          "镜头设计完成：共 " + arr.length + " 个镜头，涵盖 " +
          Object.keys(_types).length + " 种景别/类型",
          "success",
        );
        setTimeout(function () { var b = $("shotsGenBanner"); if (b) b.hidden = true; }, 2000);
        renderShotList();
      }
    },
    onTaskFailed: function (data) {
      var errText = ((data && data.errorMsg) || "生成失败").toString().slice(0, 150);
      _setShotsProgress(0, "镜头设计失败", errText);
      var banner = $("shotsGenBanner");
      if (banner) {
        var icon = banner.querySelector(".animate-spin");
        if (icon) { icon.classList.remove("animate-spin"); icon.textContent = "error"; }
      }
      showToast("镜头设计失败: " + _diagnoseApiError(errText), "error");
    },
    onBatchCompleted: function () { finish(); },
    onClose: function () { finish(); },
  });
}

/* 供 main.js reattachActiveBatches 调：刷新 / 关 tab 回来后，发现后台还有
   shots 任务在跑，就用这个函数重挂 SSE，不再发新的 /api/batch/start。 */
export function attachShotsBatch(batchId) {
  if (!batchId) return;
  return generateShots({ resumeBatchId: batchId });
}

export function saveShotEdits() {
  _syncRefs();
  if (!project || !project.shots) return;
  var wrap = $("shotListWrap");
  if (!wrap) return;
  var changed = [];
  wrap.querySelectorAll(".sc-card[data-shot-idx]").forEach(function (card) {
    var idx = parseInt(card.dataset.shotIdx, 10);
    if (isNaN(idx) || !project.shots[idx]) return;
    var shotChanged = false;
    card.querySelectorAll("[data-field]").forEach(function (el) {
      var field = el.dataset.field;
      var val = el.value.trim();
      if (project.shots[idx][field] !== val) shotChanged = true;
      project.shots[idx][field] = val;
    });
    if (shotChanged) changed.push(idx);
  });
  if (changed.length) changed.forEach(function (idx) { _markDownstreamStale("shot", { idx: idx }); });
  saveProject();
}

export function confirmShots() {
  _syncRefs();
  if (!project || !project.shots || !project.shots.length) { showToast("请先生成分镜", "warn"); return; }
  saveShotEdits();
  project.shotsApproved = true;
  project.currentStep = Math.max(project.currentStep, 4);
  saveProject();
  switchPage("images");
}

export function handleShotAction(e) {
  _syncRefs();
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var card = btn.closest(".sc-card[data-shot-idx]");
  if (!card) return;
  var idx = parseInt(card.dataset.shotIdx, 10);
  var action = btn.dataset.action;

  if (action === "ref-agent") {
    var shot = project && project.shots && project.shots[idx];
    agentInsertRef("分镜", String(idx + 1), { shotIdx: idx, visual: (shot && shot.visual) || "" });
    return;
  }
  if (action === "delete-shot") {
    if (!project || !project.shots) return;
    project.shots.splice(idx, 1);
    project.shots.forEach(function (s, i) { s.order = i + 1; s.id = "shot_" + (i + 1); });
    if (project.storyboards && project.storyboards.length) {
      project.storyboards = [];
      showToast("分镜数量变化，分镜板和视频提示词已重置", "warn");
    }
    if (project._staleFlags) {
      Object.keys(project._staleFlags).forEach(function (k) {
        if (k.indexOf("shot_") === 0 || k.indexOf("shot_prompt_") === 0 ||
            k.indexOf("storyboard_") === 0 || k.indexOf("video_prompt_") === 0) {
          delete project._staleFlags[k];
        }
      });
    }
    saveProject();
    renderShotList();
  }
}