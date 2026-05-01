import { $, escapeHtml, showToast, apiPost, apiPostStream, apiGet,
  consumeStreamStepTags, ApiError } from './utils.js';
import { attachDiagnostic } from './diagnostic.js';
import { renderStoryboardCard } from './render_hooks.js';
import { subscribeBatch } from './backend_stream.js';
import { showBillingPaywall } from './billing.js';

let _ctx = {};
let project = null;

var _imagesGenerating = false;
var _promptsConverting = false;
var IMG_PARALLEL = 3;
var MAX_SHOTS_PER_GROUP = 5;
var _sbCurrentIdx = 0;

export function initStoryboard(ctx) {
  _ctx = ctx || {};
  _syncRefs();
}

export function syncStoryboardProject(p) {
  project = p || null;
}

/**
 * 刷新 / 关 tab 后重连后端仍在跑的分镜图 & 分镜提示词 batch。
 * 模仿 videoTasks._reattachVideoBatches / assets.reattachActiveBatches。
 * 后端 batch_runner 不受前端刷新影响，apply_patch_and_save 会权威落盘；
 * 这里只重挂 SSE 订阅让 UI 恢复进度，并把已完成的结果同步到前端 project。
 */
export async function reattachStoryboardBatches() {
  _syncRefs();
  if (!project || !project.id) return;
  var resp;
  try {
    resp = await apiGet("/api/batch/active?projectId=" + encodeURIComponent(project.id));
  } catch (e) {
    console.warn("[StoryboardReattach] /api/batch/active failed:", (e && e.message) || e);
    return;
  }
  var batches = (resp && resp.batches) || [];
  if (!batches.length) return;

  batches.forEach(function (b) {
    var bt = b.batchType || "";
    var batchId = b.batchId;
    if (!batchId) return;

    if (bt === "storyboard_images") {
      _reattachImagesBatch(b);
    } else if (bt === "storyboard_prompts") {
      _reattachPromptsBatch(b);
    }
  });
}

function _reattachImagesBatch(b) {
  var batchId = b.batchId;
  var snap = b.snapshot || {};
  var tasks = b.tasks || [];
  var originId = project.id;

  console.log("[StoryboardReattach] Reattaching storyboard_images batch:", batchId,
    "total:", snap.total, "succeeded:", snap.succeeded);

  if (!project.storyboards) project.storyboards = [];

  tasks.forEach(function (t) {
    var gIdx = t.target_idx != null ? t.target_idx : ((t.extra && t.extra.groupIdx) != null ? t.extra.groupIdx : null);
    if (gIdx == null) return;
    var isDone = t.status === "succeeded" || t.status === "done" || t.status === "completed";
    var isFailed = t.status === "failed" || t.status === "timeout";
    var url = t.result_url || (t.extra && t.extra.rawUrl) || "";

    if (isDone && url) {
      if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
      if (!project.storyboards[gIdx].imageUrl) {
        project.storyboards[gIdx].imageUrl = url;
        project.storyboards[gIdx].rawUrl = url;
      }
      updateStoryboardCard(gIdx, "done", url);
    } else if (isFailed) {
      updateStoryboardCard(gIdx, "error", null, (t.error_msg || "生成失败").toString().slice(0, 120));
    } else {
      updateStoryboardCard(gIdx, "loading", null, "生成中…");
    }
  });

  var isComplete = snap.status === "completed" || snap.status === "done";
  if (isComplete) {
    _imagesGenerating = false;
    checkImagesConfirm();
    return;
  }

  _imagesGenerating = true;
  var btn = $("btnGenAllImages");
  var hint = $("imagesHint");
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + (snap.total || "?");

  // 刷新后重连场景：把 #sbDiagnostic 改成倒计时（同 generateAllImages 路径）
  var rDiagBox = $("sbDiagnostic");
  var rDoneCount = snap.succeeded || 0;
  var rFailCount = snap.failed || 0;
  var rTotal = snap.total || 0;
  // 刷新后没有"本次生成开始时刻"，从 batch 创建时间近似（不准但够用）
  var rStartTs = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
  function _renderEtaR() {
    if (!rDiagBox || !rTotal) return;
    var pending = Math.max(0, rTotal - rDoneCount - rFailCount);
    var lines = ["生成中… " + rDoneCount + "/" + rTotal];
    if (rFailCount > 0) lines.push(rFailCount + " 张失败");
    if (pending > 0) {
      var avg = (rDoneCount + rFailCount >= 1)
        ? Math.max(8, (Date.now() - rStartTs) / 1000 / (rDoneCount + rFailCount))
        : 70;
      var remain = Math.ceil(pending * avg / 4);
      lines.push("约剩 " + remain + " 秒");
    }
    rDiagBox.innerHTML = '<div class="diag-empty" style="text-align:center;padding:8px 0;font-weight:500;color:#475569;">' +
      escapeHtml(lines.join("，")) +
      '</div>';
  }
  _renderEtaR();
  var rTick = setInterval(_renderEtaR, 1000);
  function _stopTickR() { if (rTick) { clearInterval(rTick); rTick = null; } }
  function _clearEtaR() { if (rDiagBox) rDiagBox.innerHTML = ''; }

  subscribeBatch(batchId, {
    onSnapshot: function (s) {
      if (s && typeof s.total === 'number') {
        rTotal = s.total;
        if (typeof s.succeeded === 'number') rDoneCount = s.succeeded;
        if (typeof s.failed === 'number') rFailCount = s.failed;
        if (hint) hint.textContent = "生成中… " + rDoneCount + "/" + rTotal;
        _renderEtaR();
      }
    },
    onTaskStarted: function (data) {
      var extra = data.target || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : data.targetSeq;
      if (typeof groupIdx === 'number') updateStoryboardCard(groupIdx, "loading", null, "生成中…");
    },
    onTaskCompleted: function (data) {
      var extra = data.extra || {};
      var patch = data.patch || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      var rawUrl = extra.rawUrl || patch.value || data.resultUrl || '';
      if (typeof groupIdx !== 'number' || !rawUrl) return;

      _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[groupIdx] || {};
        _archiveOldImage(existing, "storyboard");
        existing.imageUrl = rawUrl;
        existing.rawUrl = rawUrl;
        if (extra.assetId) existing.imageAssetId = extra.assetId;
        if (extra.fetchStatus) existing.fetchStatus = extra.fetchStatus;
        if (Array.isArray(extra.shotIndices)) existing.shotIndices = extra.shotIndices;
        if (existing.realPhotoUrl) delete existing.realPhotoUrl;
        proj.storyboards[groupIdx] = existing;
        if (proj._staleFlags) delete proj._staleFlags["storyboard_" + groupIdx];
      }, data && data.serverVersion);
      updateStoryboardCard(groupIdx, "done", rawUrl);
      rDoneCount++;
      _renderEtaR();
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : null;
      var errMsg = (data.errorMsg || '生成失败').toString().slice(0, 120);
      if (typeof groupIdx === 'number') updateStoryboardCard(groupIdx, "error", null, errMsg);
      rFailCount++;
      _renderEtaR();
    },
    onBatchCompleted: function () {
      _imagesGenerating = false;
      if (btn) btn.disabled = false;
      _stopTickR();
      _clearEtaR();
      renderImageGrid();
      checkImagesConfirm();
    },
    onClose: function () {
      _imagesGenerating = false;
      if (btn) btn.disabled = false;
      _stopTickR();
      _clearEtaR();
    },
  });
}

function _reattachPromptsBatch(b) {
  var batchId = b.batchId;
  var snap = b.snapshot || {};
  var tasks = b.tasks || [];
  var originId = project.id;

  console.log("[StoryboardReattach] Reattaching storyboard_prompts batch:", batchId,
    "total:", snap.total, "succeeded:", snap.succeeded);

  tasks.forEach(function (t) {
    var shotIdx = t.target_idx != null ? t.target_idx : ((t.extra && t.extra.shotIdx) != null ? t.extra.shotIdx : null);
    if (shotIdx == null) return;
    var isDone = t.status === "succeeded" || t.status === "done" || t.status === "completed";
    var isFailed = t.status === "failed" || t.status === "timeout";

    if (isDone) {
      var prompt = (t.extra && t.extra.imagePrompt) || "";
      if (prompt && project.shots && project.shots[shotIdx]) {
        project.shots[shotIdx].imagePrompt = prompt;
        project.shots[shotIdx].imagePromptGenerated = true;
      }
      updatePromptCard(shotIdx, "done", prompt);
    } else if (isFailed) {
      updatePromptCard(shotIdx, "error", null, (t.error_msg || "生成失败").toString().slice(0, 100));
    } else {
      updatePromptCard(shotIdx, "loading");
    }
  });

  var isComplete = snap.status === "completed" || snap.status === "done";
  if (isComplete) {
    _promptsConverting = false;
    checkConvertConfirm();
    return;
  }

  _promptsConverting = true;
  var btn = $("btnConvertAll");
  var hint = $("convertHint");
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + (snap.total || "?");

  subscribeBatch(batchId, {
    onSnapshot: function (s) {
      if (hint && s && typeof s.total === 'number') {
        hint.textContent = "生成中… " + (s.succeeded || 0) + "/" + s.total;
      }
    },
    onTaskCompleted: function (data) {
      var extra = data.extra || {};
      var patch = data.patch || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : null;
      if (shotIdx == null) return;
      var cleaned = extra.imagePrompt || patch.value || "";
      _safeWriteBack(originId, function (proj) {
        if (proj.shots && proj.shots[shotIdx]) {
          proj.shots[shotIdx].imagePrompt = cleaned;
          proj.shots[shotIdx].imagePromptGenerated = true;
          if (proj._staleFlags) delete proj._staleFlags["shot_prompt_" + shotIdx];
        }
      }, data && data.serverVersion);
      updatePromptCard(shotIdx, "done", cleaned);
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : null;
      var errMsg = (data.errorMsg || '生成失败').toString().slice(0, 100);
      if (typeof shotIdx === 'number') updatePromptCard(shotIdx, "error", null, errMsg);
    },
    onBatchCompleted: function () {
      _promptsConverting = false;
      if (btn) btn.disabled = false;
      checkConvertConfirm();
    },
    onClose: function () {
      _promptsConverting = false;
      if (btn) btn.disabled = false;
    },
  });
}

function _syncRefs() {
  project = _ctx.getProject ? _ctx.getProject() : project;
}

function saveProject() { if (_ctx.saveProject) return _ctx.saveProject(); }
function _safeWriteBack(id, fn, serverVersion) { return _ctx.safeWriteBack ? _ctx.safeWriteBack(id, fn, serverVersion) : false; }
function switchPage(p) { if (_ctx.switchPage) _ctx.switchPage(p); }
function formatCreatorProfileForApi() { return _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null; }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }
function _isStale(key) { return _ctx.isStale ? _ctx.isStale(key) : false; }
function _checkAndSuggest(stage) { if (_ctx.checkAndSuggest) _ctx.checkAndSuggest(stage); }
function _archiveOldImage(item, source) { if (_ctx.archiveOldImage) _ctx.archiveOldImage(item, source); }
function agentInsertRef(type, label, data) { if (_ctx.agentInsertRef) _ctx.agentInsertRef(type, label, data); }
function _openLightbox(url) { if (_ctx.openLightbox) _ctx.openLightbox(url); }
function _historyBtnHtml(item, variant) { return _ctx.historyBtnHtml ? _ctx.historyBtnHtml(item, variant) : ''; }
function _openHistoryPopover(btn, item, onApply) { if (_ctx.openHistoryPopover) _ctx.openHistoryPopover(btn, item, onApply); }
function _setHistoryAsCurrent(item, hi) { return _ctx.setHistoryAsCurrent ? _ctx.setHistoryAsCurrent(item, hi) : false; }
function emotionBadgeHtml(emotion, intensity) { return _ctx.emotionBadgeHtml ? _ctx.emotionBadgeHtml(emotion, intensity) : ''; }
function sleep(ms) { return _ctx.sleep ? _ctx.sleep(ms) : new Promise(function (r) { setTimeout(r, ms); }); }

/* ================================================================
   Storyboard groups
   ================================================================ */
export function getStoryboardGroups() {
  if (!project || !project.shots) return [];
  var shots = project.shots;
  var hasGroupBoundary = shots.some(function (s) { return s.groupBoundary; });
  var rawGroups = [];

  if (!hasGroupBoundary) {
    // 按情绪段切组：同 emotion 连续的镜头放一组，emotion 变化就切；
    // 单组上限放到 4——分镜稿一张图最多画 2x2 四格，超过 4 个镜头时另起一组。
    // 之前 cap=3 会导致出现 3 格不规则布局，原网站只用 1×2 或 2×2 两种。
    var bucket = [];
    var bucketIndices = [];
    var bucketEmotion = null;
    var flush = function () {
      if (!bucket.length) return;
      rawGroups.push({
        shotIndices: bucketIndices.slice(),
        shots: bucket.slice(),
        emotion: bucketEmotion || 'general',
      });
      bucket = [];
      bucketIndices = [];
    };
    shots.forEach(function (shot, idx) {
      var em = shot.emotion || 'general';
      if (bucketEmotion === null) bucketEmotion = em;
      var emotionChanged = (em !== bucketEmotion);
      var bucketFull = (bucket.length >= 4);
      if (emotionChanged || bucketFull) {
        flush();
        bucketEmotion = em;
      }
      bucket.push(shot);
      bucketIndices.push(idx);
    });
    flush();
  } else {
    var curShots = [];
    var curIndices = [];
    shots.forEach(function (shot, idx) {
      curShots.push(shot);
      curIndices.push(idx);
      if (shot.groupBoundary || idx === shots.length - 1) {
        rawGroups.push({
          shotIndices: curIndices.slice(),
          shots: curShots.slice(),
          emotion: shot.emotion || "general"
        });
        curShots = [];
        curIndices = [];
      }
    });
  }

  // —— Normalize 阶段 ——
  // 用户要求："分镜图的排布要么 2 张要么 4 张 不要 3 张的"。这里把所有
  // 大小为 1 / 3 / >4 的分组拆并合并成清一色的 4 / 2（必要时单尾允许 1）。
  // 算法：把所有 raw groups 拍平成镜头序列（保留情绪标记），然后贪心切片：
  //   - 剩余 ≥ 4 → 切 4
  //   - 剩余 == 3 → 切 2 + 留 1（让下一轮处理；最终单尾才允许 1 格）
  //   - 剩余 == 2 → 切 2
  //   - 剩余 == 1 → 单格（仅在最后一格，无法和前一组并入时出现）
  // 同时尽量按情绪边界对齐：贪心时如果第 4 张和第 1 张情绪相差太远，优先
  // 切 2 而不是切 4——避免一张分镜稿里前后情绪拧得太别扭。
  var flat = [];
  rawGroups.forEach(function (g) {
    g.shotIndices.forEach(function (si, i) {
      flat.push({ idx: si, shot: g.shots[i], emotion: g.emotion });
    });
  });

  // 用户反馈："视频节奏太慢了 我觉得是分镜图太多了的原因 ... 把在5秒内能完成
  // 的内容放在一块 但是要保证能演完 比如前三个分镜其实一个分镜就能搞定了"
  //
  // Seedance 2.0 (doubao-seedance-2-0-260128) 只支持固定 3/5/10/15s 几档；
  // 后端已锁死每段 5s。这里前端的分组算法配合：每段尽量打包 MAX_SHOTS_PER_GROUP
  // 个连续同情绪镜头，让最终分镜数量大幅减少（实测 8 段→约 5-6 段）。
  //
  // 算法：
  //   · 严格按情绪段切分（setup / rising / climax / falling / resolution
  //     之间一定是不同的分镜稿——情绪转折是讲故事节奏的天然边界）
  //   · 每段最多打包 MAX_SHOTS_PER_GROUP（4）个镜头，让一张分镜稿正好画 2×2
  //   · 同情绪段 5+ 镜头 → 平均切（3+2 而不是 4+1，避免孤儿镜头）
  //
  // 注意：之前还做过"单镜头台词密集（>50 字）独立成组"的处理——这是错的，
  // 用户的剧本里多角色对白经常 50+ 字一镜，独立成组反而又把分镜数顶回 8 张。
  // 现在去掉密集检测：信任模型在 5s 视频里用快剪表现多角色对白。
  var MAX_SHOTS_PER_GROUP = 4;

  // 第一步：按情绪段切成 emotion buckets
  var emoBuckets = [];
  var curBucket = [];
  var curEm = null;
  flat.forEach(function (item) {
    if (curEm === null) curEm = item.emotion;
    if (item.emotion !== curEm) {
      if (curBucket.length) emoBuckets.push({ items: curBucket, emotion: curEm });
      curBucket = [item];
      curEm = item.emotion;
    } else {
      curBucket.push(item);
    }
  });
  if (curBucket.length) emoBuckets.push({ items: curBucket, emotion: curEm });

  // 第二步：每个情绪 bucket 内部均匀切成 MAX_SHOTS 张/组
  var groups = [];
  emoBuckets.forEach(function (eb) {
    var items = eb.items;
    var n = items.length;
    if (!n) return;
    // 计算切几组：n=1 → 1, n=2-4 → 1, n=5 → 2 (3+2), n=6 → 2 (3+3),
    //            n=7 → 2 (4+3), n=8 → 2 (4+4), n=9 → 3 (3+3+3), 以此类推
    var groupCount = Math.ceil(n / MAX_SHOTS_PER_GROUP);
    var perGroup = Math.ceil(n / groupCount); // 平均每组数量（向上取整）
    var k = 0;
    for (var gi = 0; gi < groupCount; gi++) {
      var remainingGroups = groupCount - gi;
      var remainingItems = n - k;
      // 让最后几组不会太小：用动态平均 ceil(remaining / remainingGroups)
      var take = Math.min(perGroup, Math.ceil(remainingItems / remainingGroups));
      var slice = items.slice(k, k + take);
      groups.push({
        groupIdx: groups.length,
        shotIndices: slice.map(function (x) { return x.idx; }),
        shots: slice.map(function (x) { return x.shot; }),
        emotion: eb.emotion,
      });
      k += take;
    }
  });

  return groups;
}

function _getShotGroupIndices() {
  var map = {};
  if (!project || !project.shots) return map;
  var groups = getStoryboardGroups();
  groups.forEach(function (g) {
    g.shotIndices.forEach(function (si) { map[si] = g.groupIdx; });
  });
  return map;
}

/* ================================================================
   Images page
   ================================================================ */
export function refreshImagesPage() {
  _syncRefs();
  var needShots = $("imagesNeedShots");
  var ready = $("imagesReady");
  var actionBar = $("imagesActionBar");
  if (!project || !project.shotsApproved || !project.shots || !project.shots.length) {
    if (needShots) needShots.hidden = false;
    if (ready) ready.hidden = true;
    if (actionBar) actionBar.hidden = true;
    var ig = $("imageGrid"); if (ig) ig.innerHTML = "";
    return;
  }
  needShots.hidden = true;
  ready.hidden = false;
  renderImageGrid();
  checkImagesConfirm();
}

/* ── Step A: AI prompt generation ── */

export function renderPromptPreviewList() {
  _syncRefs();
  var list = $("promptPreviewList");
  if (!list || !project || !project.shots) return;
  list.innerHTML = "";
  project.shots.forEach(function (shot, idx) {
    var card = document.createElement("div");
    card.className = "prompt-preview-card" + (shot.imagePromptGenerated ? " is-done" : "");
    card.dataset.shotIdx = idx;
    var isPromptStale = _isStale("shot_prompt_" + idx);
    var statusHtml = '';
    if (shot.imagePromptGenerated && isPromptStale) statusHtml = '<span class="prompt-preview-status stale-warn">&#9888; 需更新</span>';
    else if (shot.imagePromptGenerated) statusHtml = '<span class="prompt-preview-status ok">&#10003; 已生成</span>';
    else statusHtml = '<span class="prompt-preview-status wait">待生成</span>';

    card.innerHTML =
      '<div class="prompt-preview-head">' +
        '<div class="prompt-preview-num">' + (idx + 1) + '</div>' +
        '<span class="prompt-preview-scene">镜头 ' + (idx + 1) + ' · ' + escapeHtml(shot.shotType || "") + '</span>' +
        statusHtml +
      '</div>' +
      '<div class="prompt-preview-desc">' + escapeHtml((shot.visual || "").slice(0, 80) || "无描述") + '</div>' +
      '<div class="prompt-preview-prompt">' + escapeHtml(shot.imagePrompt || "") + '</div>' +
      '<div class="prompt-preview-actions">' +
        '<button type="button" class="btn btn-secondary btn-sm" data-action="regen-convert">重新生成</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-action="edit-convert">手动编辑</button>' +
      '</div>';
    list.appendChild(card);
  });
}

export function updatePromptCard(idx, status, promptText, errMsg) {
  var list = $("promptPreviewList");
  if (!list) return;
  var card = list.querySelector('[data-shot-idx="' + idx + '"]');
  if (!card) return;
  var statusEl = card.querySelector(".prompt-preview-status");
  var promptEl = card.querySelector(".prompt-preview-prompt");

  if (status === "loading") {
    card.classList.remove("is-done", "is-err");
    if (statusEl) { statusEl.className = "prompt-preview-status wait"; statusEl.innerHTML = "生成中…"; }
    if (promptEl) promptEl.textContent = "";
  } else if (status === "done") {
    card.classList.add("is-done");
    card.classList.remove("is-err");
    if (statusEl) { statusEl.className = "prompt-preview-status ok"; statusEl.innerHTML = "&#10003; 已生成"; }
    if (promptEl) promptEl.textContent = promptText || "";
  } else if (status === "error") {
    card.classList.add("is-err");
    card.classList.remove("is-done");
    if (statusEl) { statusEl.className = "prompt-preview-status err"; statusEl.textContent = "失败"; }
    if (promptEl) promptEl.textContent = errMsg || "生成失败";
  }
}

export function checkConvertConfirm() {
  var area = $("convertConfirmArea");
  if (!area || !project || !project.shots) return;
  var allDone = project.shots.length > 0 && project.shots.every(function (s) { return s.imagePromptGenerated && s.imagePrompt; });
  area.hidden = !allDone;
}

export async function convertSinglePrompt(idx) {
  if (!project) return;
  var shot = project.shots[idx];
  if (!shot) return;
  var originId = project.id;
  updatePromptCard(idx, "loading");

  var assetRefs = [];
  try {
    var refResp = await apiPost('/api/assets/match-references', {
      project: { assets: project.assets },
      shot: shot,
    });
    assetRefs = refResp.refs || [];
  } catch (e) {
    console.warn('[ImagePrompt] match-references failed, continuing without refs:', e);
  }
  var imageUrls = [];
  assetRefs.forEach(function (r) {
    var imgUrl = r.pencilUrl || r.url;
    if (imgUrl) imageUrls.push(imgUrl);
  });

  try {
    var _sbDiagBox = (window.__qdIsAdmin === true)
      ? ($("sbDiagnostic_" + idx) || $("sbDiagnostic"))
      : null;
    if (_sbDiagBox) _sbDiagBox.hidden = false;
    var _sbDiagCaptor = _sbDiagBox ? attachDiagnostic(_sbDiagBox) : null;
    var resp = await apiPostStream("/api/storyboard/convert-prompt", {
      shot: shot,
      styleBible: project.styleBible,
      assets: project.assets,
      assetRefs: assetRefs,
      idx: idx,
      imageUrls: imageUrls,
      creatorProfile: formatCreatorProfileForApi(),
    }, function () {}, _sbDiagCaptor ? _sbDiagCaptor.onEvent : null);

    var cleaned = (resp.imagePrompt || "").trim().replace(/^["']|["']$/g, "");
    var isCurrent = _safeWriteBack(originId, function (proj) {
      if (proj.shots && proj.shots[idx]) {
        proj.shots[idx].imagePrompt = cleaned;
        proj.shots[idx].imagePromptGenerated = true;
        if (proj._staleFlags) delete proj._staleFlags["shot_prompt_" + idx];
      }
    });
    if (isCurrent) updatePromptCard(idx, "done", cleaned);
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 100);
    updatePromptCard(idx, "error", null, errMsg);
    throw e;
  }
}

/* ================================================================
   批量转换 prompt — Phase 3-B-1 pilot
   主路径：POST /api/batch/start + SSE subscribeBatch
   Fallback：/api/batch/start 4xx（executor 没注册等）时走老循环
   ================================================================ */
export async function convertAllPrompts() {
  if (!project || !project.shots) return;
  if (_promptsConverting) { showToast("正在生成中，请稍候", "warn"); return; }
  _promptsConverting = true;
  var btn = $("btnConvertAll");
  var hint = $("convertHint");
  if (btn) btn.disabled = true;

  var originId = project.id;
  var targetIdxs = project.shots.map(function (_, i) { return i; })
    .filter(function (i) { return !project.shots[i].imagePromptGenerated || !project.shots[i].imagePrompt; });
  if (!targetIdxs.length) targetIdxs = project.shots.map(function (_, i) { return i; });
  var total = targetIdxs.length;

  targetIdxs.forEach(function (i) { updatePromptCard(i, "loading"); });
  if (hint) hint.textContent = "启动中… 0/" + total;

  // targetSeq -> shotIdx：task_failed 的 extra 里没 shotIdx 时用它反查
  var seqToShotIdx = {};
  targetIdxs.forEach(function (shotIdx, seq) { seqToShotIdx[seq] = shotIdx; });

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_prompts',
      projectId: originId,
      targets: targetIdxs.map(function (i) { return { idx: i }; }),
      options: { creatorProfile: formatCreatorProfileForApi() },
    });
  } catch (e) {
    _promptsConverting = false;
    if (btn) btn.disabled = false;
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (hint) hint.textContent = "批量启动失败：" + errMsg;
    showToast("批量启动失败：" + _diagnoseApiError(errMsg), "error");
    targetIdxs.forEach(function (i) { updatePromptCard(i, "error", null, errMsg); });
    return;
  }

  var doneCount = 0;
  var failCount = 0;

  function finish() {
    if (!_promptsConverting) return;  // 去重
    _promptsConverting = false;
    if (btn) btn.disabled = false;
    var done = project.shots.filter(function (s) { return s.imagePromptGenerated; }).length;
    if (hint) hint.textContent = done + "/" + project.shots.length + " 条已生成";
    checkConvertConfirm();
  }

  subscribeBatch(startResp.batchId, {
    onSnapshot: function (snap) {
      // 刷新页面 / 晚订阅时，这是第一帧：用累计数把进度条先对齐一下
      if (hint && snap && typeof snap.total === 'number') {
        hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + snap.total;
      }
    },
    onTaskCompleted: function (data) {
      doneCount++;
      var extra = data.extra || {};
      var patch = data.patch || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : seqToShotIdx[data.targetSeq];
      if (typeof shotIdx !== 'number') return;
      var cleaned = extra.imagePrompt || patch.value || "";
      var isCurrent = _safeWriteBack(originId, function (proj) {
        if (proj.shots && proj.shots[shotIdx]) {
          proj.shots[shotIdx].imagePrompt = cleaned;
          proj.shots[shotIdx].imagePromptGenerated = true;
          if (proj._staleFlags) delete proj._staleFlags["shot_prompt_" + shotIdx];
        }
      }, data && data.serverVersion);
      if (isCurrent) updatePromptCard(shotIdx, "done", cleaned);
      if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + total;
    },
    onTaskFailed: function (data) {
      failCount++;
      var extra = data.extra || {};
      var shotIdx = (typeof extra.shotIdx === 'number') ? extra.shotIdx : seqToShotIdx[data.targetSeq];
      var errMsg = (data.errorMsg || '生成失败').toString().slice(0, 100);
      if (typeof shotIdx === 'number') updatePromptCard(shotIdx, "error", null, errMsg);
      if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + total;
    },
    onBatchCompleted: function () {
      if (failCount > 0) showToast(failCount + " 条生成失败", "warn");
      finish();
    },
    onClose: function () {
      // SSE 断开（非正常结束）：保底把按钮还回来，用户可重试
      finish();
    },
  });
}

/**
 * 老的前端循环路径，只在 /api/batch/start 4xx 时兜底。
 * 等后端 executor 稳定后删（Phase 3-B-2 收尾）。
 */
export function confirmPrompts() {
  if (!project || !project.shots) return;
  var missing = project.shots.filter(function (s) { return !s.imagePromptGenerated || !s.imagePrompt; });
  if (missing.length) { showToast("还有 " + missing.length + " 条提示词未生成", "warn"); return; }
  var stepGenerate = $("imgStepGenerate");
  if (stepGenerate) stepGenerate.hidden = false;
  var stepConvert = $("imgStepConvert");
  if (stepConvert) {
    var area = stepConvert.querySelector(".action-area");
    if (area) area.hidden = true;
  }
  renderImageGrid();
}

function _sbPromptShort(text, maxLen) {
  var t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  maxLen = maxLen || 120;
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "…";
}

export function renderImageGrid() {
  _syncRefs();
  var grid = $("imageGrid");
  if (!grid || !project || !project.shots) return;
  grid.innerHTML = "";
  if (!project.storyboards) project.storyboards = [];
  var groups = getStoryboardGroups();

  var actionBar = $("imagesActionBar");
  if (actionBar) actionBar.hidden = false;

  groups.forEach(function (group, gIdx) {
    var sb = project.storyboards[gIdx] || {};
    var hasImg = !!(sb.imageUrl || sb.rawUrl);
    var imgSrc = sb.rawUrl || sb.imageUrl || '';
    var shotLabel = 'SHOT ' + String(group.shotIndices[0]+1).padStart(2,'0');
    if (group.shotIndices.length > 1) shotLabel += '-' + String(group.shotIndices[group.shotIndices.length-1]+1).padStart(2,'0');
    shotLabel += ' · ' + (group.shots[0].shotType || 'Shot');
    var groupEmotion = group.emotion || (group.shots[0] && group.shots[0].emotion) || "";
    var groupIntensity = 3;
    if (group.shots.length) {
      var total = 0;
      group.shots.forEach(function (s) { total += (s.intensity || 3); });
      groupIntensity = Math.round(total / group.shots.length);
    }
    var emotionTag = groupEmotion ? emotionBadgeHtml(groupEmotion, groupIntensity) : "";

    // 英文 prompt（仅给图像模型用，调试时折叠展示）
    var promptText = group.shots.map(function (s) {
      return s.imagePrompt || '';
    }).filter(function (p) { return p; }).join('\n---\n');

    // 用户主显示：中文画面描述（拼接同组每个镜头的 visual / shotType）
    var visualText = group.shots.map(function (s, _i) {
      var st = s.shotType ? '【' + s.shotType + '】' : '';
      var v = s.visual || s.description || '';
      return (st + v).trim();
    }).filter(function (v) { return v; }).join(' ');

    var fullPromptDisplay = visualText || promptText || '';
    var hasFullPrompt = !!String(fullPromptDisplay).trim();
    var promptSummaryLine = hasFullPrompt ? _sbPromptShort(fullPromptDisplay, 120) : "";

    var card = document.createElement("div");
    card.className = "sb-sheet flex-none w-[75vw] md:w-[65vw] lg:w-[60vw] h-full snap-center-custom flex flex-col";
    card.dataset.groupIdx = gIdx;

    card.innerHTML =
      '<div class="flex-1 bg-surface-container-lowest/40 backdrop-blur-xl rounded-[2.5rem] border border-white/30 overflow-hidden shadow-2xl transition-transform duration-500 hover:scale-[1.005] group relative">' +
        // 用户反馈："生成分镜图的时候 前面图还在 然后生成失败"——之前 loading
        // 用 bg-white/60 半透明，老图透出来；现在改成完全不透明，再生成时
        // 用户看到的就是干净的 loading 状态而不是"老图 + 一层蒙版"。
        '<div class="sb-sheet-loading absolute inset-0 flex items-center justify-center bg-white z-30 rounded-[2.5rem]" hidden>' +
          '<div class="text-center">' +
            '<div class="inline-block w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin mb-3"></div>' +
            '<span class="block text-xs font-bold text-on-surface-variant">生成中…</span>' +
          '</div>' +
        '</div>' +
        // 错误态也改成全屏不透明卡片，覆盖老图。失败时用户能立刻看到红色提示
        // 而不是"老图依旧 + 底部一行小字"。
        '<div class="sb-sheet-error absolute inset-0 flex flex-col items-center justify-center bg-white z-30 rounded-[2.5rem] p-8 text-center" hidden>' +
          '<span class="material-symbols-outlined text-5xl text-error mb-3">error_outline</span>' +
          '<span class="text-sm font-bold text-error mb-2">分镜图生成失败</span>' +
          '<span class="sb-error-msg text-xs text-on-surface-variant/80 max-w-md leading-relaxed"></span>' +
          '<span class="text-[10px] text-on-surface-variant/40 mt-4">点击下方「重新生成」可再次尝试</span>' +
        '</div>' +
        '<div class="absolute inset-0 p-8 flex flex-col">' +
          '<div class="flex items-center justify-between mb-5">' +
            '<div class="flex items-center gap-4">' +
              '<span class="px-3 py-1 bg-primary/10 text-primary text-[10px] font-black uppercase tracking-[0.2em] rounded-full border border-primary/20">' +
                'Scene ' + String(gIdx+1).padStart(2,'00') +
              '</span>' +
              '<span class="text-lg font-bold tracking-tight text-on-background">分镜板 ' + (gIdx+1) + '</span>' +
              (_isStale("storyboard_" + gIdx) ? '<span class="stale-badge" title="前序内容已修改，建议重新生成">需更新</span>' : '') +
              '<span class="text-xs text-on-surface-variant/50 font-medium">' + group.shots.length + ' Shots</span>' +
              emotionTag +
            '</div>' +
            '<div class="flex items-center gap-2">' +
              '<span class="text-[10px] text-on-surface-variant/30 font-bold tracking-widest uppercase">' + group.shots.length + ' shots</span>' +
            '</div>' +
          '</div>' +
          '<div class="flex-1 bg-white rounded-3xl overflow-hidden border border-outline-variant/10 shadow-inner relative group-hover:shadow-xl transition-shadow duration-500 min-h-0">' +
            (hasImg
              ? '<img class="w-full h-full object-cover scale-105 group-hover:scale-100 transition-transform duration-1000 ease-out cursor-pointer" data-action="lightbox" src="' + escapeHtml(imgSrc) + '" />'
              : '<div class="sb-sheet-placeholder w-full h-full flex flex-col items-center justify-center bg-surface-container text-on-surface-variant/20">' +
                  '<span class="material-symbols-outlined text-7xl mb-3">brush</span>' +
                  '<span class="text-xs font-bold uppercase tracking-[0.3em]">待生成</span>' +
                '</div>') +
          '</div>' +
          '<div class="mt-5 min-h-0 shrink-0">' +
            '<div class="flex items-center gap-3 mb-2">' +
              '<span class="text-[12px] font-black uppercase tracking-widest text-primary">' + escapeHtml(shotLabel) + '</span>' +
              '<div class="h-px flex-1 bg-outline-variant/20"></div>' +
            '</div>' +
            (hasFullPrompt
              ? '<details class="sb-prompt-details mb-4 max-w-full">' +
                  '<summary class="text-[11px] leading-relaxed text-on-surface-variant/70 font-medium cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-start gap-1 select-none">' +
                    '<span class="material-symbols-outlined text-[14px] shrink-0 text-primary/70">expand_more</span>' +
                    '<span class="font-mono line-clamp-2">' + escapeHtml(promptSummaryLine) + '</span>' +
                  '</summary>' +
                  '<div class="mt-2 text-[11px] leading-relaxed text-on-surface-variant/85 font-mono whitespace-pre-wrap break-words max-h-52 overflow-y-auto rounded-2xl bg-surface-container-lowest/40 p-3 border border-outline-variant/10">' +
                    escapeHtml(fullPromptDisplay) +
                  '</div>' +
                '</details>'
              : '<p class="text-[11px] leading-relaxed text-on-surface-variant/60 font-medium mb-4 font-mono">待生成</p>') +
            '<div class="flex items-center gap-2 flex-wrap">' +
              '<button type="button" class="w-9 h-9 rounded-full bg-surface-container-lowest/70 flex items-center justify-center hover:bg-white transition-colors" data-action="ref-agent-sb" title="引用到 AI 助手"><span class="material-symbols-outlined text-sm text-on-surface-variant">alternate_email</span></button>' +
              '<button type="button" class="flex items-center gap-1.5 px-4 py-2 bg-primary text-on-primary rounded-full text-[10px] font-bold tracking-widest uppercase hover:opacity-90 transition-all active:scale-95 shadow-md" data-action="regen-sb">' +
                '<span class="material-symbols-outlined text-sm">refresh</span>重新生成' +
              '</button>' +
              _historyBtnHtml(sb, "sb") +
              '<button type="button" class="flex items-center gap-1.5 px-4 py-2 bg-white/60 hover:bg-white/90 text-on-surface-variant rounded-full text-[10px] font-bold tracking-widest uppercase transition-all active:scale-95 border border-outline-variant/20" data-action="regen-sb-prompt">' +
                '<span class="material-symbols-outlined text-sm">auto_fix_high</span>重写提示词' +
              '</button>' +
              (promptText
                ? '<button type="button" class="flex items-center gap-1.5 px-4 py-2 bg-white/60 hover:bg-white/90 text-on-surface-variant rounded-full text-[10px] font-bold tracking-widest uppercase transition-all active:scale-95 border border-outline-variant/20 sb-toggle-prompt">' +
                    '<span class="material-symbols-outlined text-sm">edit_note</span>编辑提示词' +
                  '</button>'
                : '') +
              (hasImg
                ? '<button type="button" class="ml-auto w-9 h-9 rounded-full bg-white/40 hover:bg-white/80 transition-colors flex items-center justify-center text-on-surface-variant" data-action="download-sb" title="下载">' +
                    '<span class="material-symbols-outlined text-lg">download</span>' +
                  '</button>'
                : '') +
            '</div>' +
            '<div class="sb-prompt-area mt-3" hidden>' +
              '<textarea class="sb-prompt-edit w-full bg-surface-container-lowest text-[11px] text-on-surface-variant rounded-2xl p-3 border border-outline-variant/10 focus:ring-1 focus:ring-primary/30 focus:outline-none resize-none leading-relaxed" rows="3" data-gidx="' + gIdx + '">' + escapeHtml(promptText) + '</textarea>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    grid.appendChild(card);
  });

  grid.querySelectorAll(".sb-prompt-edit").forEach(function (ta) {
    ta.addEventListener("blur", function () {
      var gIdx = parseInt(ta.dataset.gidx, 10);
      if (isNaN(gIdx)) return;
      var grps = getStoryboardGroups();
      var grp = grps[gIdx];
      if (!grp) return;
      var parts = ta.value.split(/\n---\n/);
      var _changed = false;
      grp.shots.forEach(function (shot, i) {
        if (parts[i] !== undefined) {
          var _newP = parts[i].trim();
          if (project.shots[grp.shotIndices[i]].imagePrompt !== _newP) _changed = true;
          project.shots[grp.shotIndices[i]].imagePrompt = _newP;
          project.shots[grp.shotIndices[i]].imagePromptGenerated = true;
        }
      });
      if (_changed && project.storyboards && project.storyboards[gIdx] && project.storyboards[gIdx].imageUrl) {
        if (!project._staleFlags) project._staleFlags = {};
        project._staleFlags["storyboard_" + gIdx] = true;
      }
      saveProject();
    });
  });

  grid.querySelectorAll(".sb-toggle-prompt").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var card = btn.closest(".sb-sheet");
      if (!card) return;
      var area = card.querySelector(".sb-prompt-area");
      if (area) {
        area.hidden = !area.hidden;
        if (!area.hidden) {
          var ta = area.querySelector("textarea");
          if (ta) ta.focus();
        }
      }
    });
  });

  _initGalleryDrag(grid);
  _updateNavDots(groups.length);
  _sbCurrentIdx = 0;
}

function _initGalleryDrag(container) {
  var isDown = false, startX, scrollLeft, hasDragged = false;
  container.addEventListener("mousedown", function (e) {
    if (e.target.closest("button, textarea, select, a, details, summary, input")) return;
    isDown = true;
    hasDragged = false;
    container.classList.add("active");
    startX = e.pageX - container.offsetLeft;
    scrollLeft = container.scrollLeft;
  });
  container.addEventListener("mouseleave", function () { isDown = false; container.classList.remove("active"); });
  container.addEventListener("mouseup", function () {
    isDown = false;
    container.classList.remove("active");
    if (hasDragged) _syncNavFromScroll(container);
  });
  container.addEventListener("mousemove", function (e) {
    if (!isDown) return;
    e.preventDefault();
    hasDragged = true;
    var x = e.pageX - container.offsetLeft;
    container.scrollLeft = scrollLeft - (x - startX) * 1.5;
  });
  container.addEventListener("scroll", _debounce(function () {
    _syncNavFromScroll(container);
  }, 120));
}

function _debounce(fn, ms) {
  var timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function _updateNavDots(count) {
  var dotsWrap = $("sbNavDots");
  if (!dotsWrap) return;
  dotsWrap.innerHTML = "";
  for (var i = 0; i < count; i++) {
    var dot = document.createElement("div");
    dot.className = i === _sbCurrentIdx
      ? "w-10 h-1 bg-primary rounded-full transition-all"
      : "w-4 h-1 bg-primary/20 rounded-full transition-all";
    dot.dataset.dotIdx = i;
    dotsWrap.appendChild(dot);
  }
}

function _syncNavFromScroll(container) {
  var cards = container.querySelectorAll(".sb-sheet");
  if (!cards.length) return;
  var containerRect = container.getBoundingClientRect();
  var center = containerRect.left + containerRect.width / 2;
  var closest = 0, minDist = Infinity;
  cards.forEach(function (c, i) {
    var r = c.getBoundingClientRect();
    var d = Math.abs(r.left + r.width / 2 - center);
    if (d < minDist) { minDist = d; closest = i; }
  });
  if (closest !== _sbCurrentIdx) {
    _sbCurrentIdx = closest;
    _updateNavDots(cards.length);
  }
}

export function getSbCurrentIdx() { return _sbCurrentIdx; }

export function scrollToCard(idx) {
  var grid = $("imageGrid");
  if (!grid) return;
  var cards = grid.querySelectorAll(".sb-sheet");
  if (idx < 0 || idx >= cards.length) return;
  cards[idx].scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  _sbCurrentIdx = idx;
  _updateNavDots(cards.length);
}

export function updateStoryboardCard(gIdx, status, imgUrl, errMsg) {
  // Phase 3-A：DOM 级渲染委托给 render_hooks.renderStoryboardCard。
  // 顺手修 audit P0-4：done 时实际更新 <img src>，原来只关 overlay 不换图
  // 导致生成成功后卡片还显示旧图 / 占位符，需要用户手动刷新才能看到新图。
  // done + 无 <img>（之前只是占位符）时，由 needFullRerender 触发整体重渲。
  var result = renderStoryboardCard(gIdx, status, {
    imgUrl: imgUrl,
    loadingText: (status === "loading") ? errMsg : undefined,
    errMsg: (status === "error") ? errMsg : undefined,
  });
  if (!result.ok) return;
  if (result.needFullRerender) renderImageGrid();
}

export function checkImagesConfirm() {
  var area = $("imagesConfirmArea");
  if (!area || !project || !project.shots) return;
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var allDone = groups.length > 0 && groups.every(function (_, i) {
    return project.storyboards[i] && project.storyboards[i].imageUrl;
  });
  area.hidden = !allDone;
}

/**
 * Phase 3-B-8：单张分镜图重生成 = 单元素 `storyboard_images` batch。
 *
 * 和"一键生成全部分镜图"完全共用 `storyboard_image_executor`：prompt 组装
 * 走后端同一条路径（`_build_storyboard_prompt`），成功后 `apply_patch_and_save`
 * 权威落盘；前端只挂 SSE 看进度 + 乐观刷卡片。不再用 `apiImageGenerate`
 * / `_pendingImageTasks` 这些前端自管套件。
 */
export async function generateStoryboardSheet(gIdx) {
  if (!project) return;
  var groups = getStoryboardGroups();
  var group = groups[gIdx];
  if (!group) return;
  if (!project.storyboards) project.storyboards = [];
  var originId = project.id;

  var hasSomePrompt = group.shots.some(function (s) { return s.imagePrompt || s.visual; });
  if (!hasSomePrompt) {
    updateStoryboardCard(gIdx, "error", null, "该组镜头无描述，请先完成 AI 生成或镜头设计");
    return;
  }

  updateStoryboardCard(gIdx, "loading", null, "生成素描电影分镜…");

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: [{ groupIdx: gIdx, idx: gIdx, shotIndices: group.shotIndices || [] }],
    });
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, '积分不足');
      showBillingPaywall(e.billing || null);
      return;
    }
    if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, errMsg);
    showToast("分镜图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsg), "error");
    return;
  }
  if (!startResp || !startResp.batchId) {
    var fErr = (startResp && startResp.error) || "未能创建批量任务";
    updateStoryboardCard(gIdx, "error", null, fErr);
    showToast("分镜图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(fErr), "error");
    return;
  }

  return new Promise(function (resolve) {
    var settled = false;
    var pollTimer = null;
    var _gotResult = false;
    // —— 单张分镜倒计时 ——
    // 用户反馈："单独生成第一张的时候没有倒计时"——和批量入口一样，
    // 单张重生成也给一个"约剩 N 秒"的友好提示。medium 画质 + 中转排队
    // 实测一张 60-90 秒，初始猜测 70 秒，每秒 -1 直到 5 秒兜底（避免
    // 显示 0 / 负数让用户以为卡住）。
    var etaStart = Date.now();
    var initialEtaSec = 70;
    var etaTimer = null;
    function _updateEta() {
      if (settled) return;
      var elapsed = Math.floor((Date.now() - etaStart) / 1000);
      var remain = Math.max(5, initialEtaSec - elapsed);
      try { updateStoryboardCard(gIdx, "loading", null, "生成分镜中…约剩 " + remain + " 秒"); } catch (_e) {}
    }
    function _stopEta() { if (etaTimer) { clearInterval(etaTimer); etaTimer = null; } }
    _updateEta();
    etaTimer = setInterval(_updateEta, 1000);
    function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function finish() { if (!settled) { settled = true; _stopPoll(); _stopEta(); resolve(); } }

    function _applyResult(rawUrl, extra) {
      if (!rawUrl || _gotResult) return;
      _gotResult = true;
      var isCurrent = _safeWriteBack(originId, function (proj) {
        if (!proj.storyboards) proj.storyboards = [];
        var existing = proj.storyboards[gIdx] || {};
        _archiveOldImage(existing, "storyboard");
        existing.imageUrl = rawUrl;
        existing.rawUrl = rawUrl;
        if (extra && extra.assetId) existing.imageAssetId = extra.assetId;
        if (extra && extra.fetchStatus) existing.fetchStatus = extra.fetchStatus;
        existing.shotIndices = (extra && extra.shotIndices) || group.shotIndices;
        if (existing.realPhotoUrl) delete existing.realPhotoUrl;
        proj.storyboards[gIdx] = existing;
        if (proj._staleFlags) delete proj._staleFlags["storyboard_" + gIdx];
      });
      if (isCurrent) updateStoryboardCard(gIdx, "done", rawUrl);
    }

    // 5 秒兜底轮询：SSE 偶尔丢事件，靠它从 /api/batch/<id> 拿权威结果
    async function _pollOnce() {
      if (settled) return;
      try {
        var snap = await apiGet("/api/batch/" + encodeURIComponent(startResp.batchId));
        if (!snap || settled) return;
        var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
        tasks.forEach(function (t) {
          if (t.status === 'completed' && !_gotResult) {
            var result = t.result || {};
            var extra = result.extra || {};
            var patch = result.patch || {};
            var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
            _applyResult(url, extra);
          } else if (t.status === 'failed' && !_gotResult) {
            var errMsgPoll = (t.errorMsg || '生成失败').toString().slice(0, 120);
            if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, errMsgPoll);
            showToast("分镜图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsgPoll), "error");
            _gotResult = true;
          }
        });
        if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') {
          finish();
        }
      } catch (e) {
        console.warn('[StoryboardImg-single] poll failed:', (e && e.message) || e);
      }
    }
    pollTimer = setInterval(_pollOnce, 5000);

    subscribeBatch(startResp.batchId, {
      onTaskCompleted: function (data) {
        var extra = (data && data.extra) || {};
        var patch = (data && data.patch) || {};
        var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || patch.value || (data && data.resultUrl) || "";
        _applyResult(rawUrl, extra);
      },
      onTaskFailed: function (data) {
        var errMsgInner = ((data && data.errorMsg) || "生成失败").toString().slice(0, 120);
        if (project && project.id === originId) updateStoryboardCard(gIdx, "error", null, errMsgInner);
        showToast("分镜图 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsgInner), "error");
        _gotResult = true;
      },
      onBatchCompleted: finish,
      onClose: function () {
        // SSE 断了不立即 finish，让 polling 跑到 batch 真完成
      },
    });
  });
}

async function _autoConvertGroupPrompts(group) {
  if (!project) return;
  var needConvert = group.shots.filter(function (s) {
    return !s.imagePromptGenerated || !s.imagePrompt;
  });
  if (!needConvert.length) return;

  for (var i = 0; i < group.shotIndices.length; i++) {
    var sIdx = group.shotIndices[i];
    var shot = project.shots[sIdx];
    if (shot && (!shot.imagePromptGenerated || !shot.imagePrompt)) {
      await convertSinglePrompt(sIdx);
    }
  }
}

export async function generateAllImages() {
  if (_imagesGenerating) return;
  if (!project || !project.shots || !project.shots.length) return;
  _imagesGenerating = true;
  var btn = $("btnGenAllImages");
  var hint = $("imagesHint");
  if (btn) btn.disabled = true;
  if (!project.storyboards) project.storyboards = [];

  var originId = project.id;
  var groups = getStoryboardGroups();

  // Step 1：串行把每个组的 shot prompt 补齐（convertSinglePrompt 还没批量化，
  // 这一步仍然是前端串行调用）
  if (hint) hint.textContent = "生成提示词中…";
  for (var gi = 0; gi < groups.length; gi++) {
    var g0 = groups[gi];
    var ready = g0.shots.every(function (s) { return s.imagePromptGenerated && s.imagePrompt; });
    if (!ready) updateStoryboardCard(gi, "loading", null, "生成提示词中…");
  }
  try {
    for (var gj = 0; gj < groups.length; gj++) {
      await _autoConvertGroupPrompts(groups[gj]);
    }
  } catch (e) {
    if (hint) hint.textContent = "提示词生成失败：" + ((e && e.message) || e);
    showToast("提示词生成失败：" + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
    return;
  }

  // 提示词补齐后重新取最新 project（_autoConvertGroupPrompts 内部有 saveProject）
  _syncRefs();
  groups = getStoryboardGroups();

  // Step 2：过滤仍缺图的组
  // 同时**裁剪 storyboards 数组**到当前分组数：之前用旧分组算法生成的
  // 多余 panel（比如旧算法 cap=3 出 7 组，新算法 cap=4 只出 5 组）会残留
  // 在尾部，并且前几个 slot 里的 shotIndices 和当前分组对不上时，UI 取
  // storyboards[i] 拿到的就是错位的旧图——表现为"前 N 张图布局对不上"。
  // 这里在开新 batch 前先做一次清理：
  //   1. 截短到当前分组数
  //   2. 任何 slot 里 shotIndices 和当前分组的 shotIndices 不一致 → 视为脏图丢掉
  if (!Array.isArray(project.storyboards)) project.storyboards = [];
  if (project.storyboards.length > groups.length) {
    project.storyboards.length = groups.length;
  }
  var dirtyCleared = 0;
  for (var ck = 0; ck < groups.length; ck++) {
    var existing = project.storyboards[ck];
    if (!existing) continue;
    var savedSi = Array.isArray(existing.shotIndices) ? existing.shotIndices : null;
    var newSi = groups[ck].shotIndices || [];
    var match = savedSi && savedSi.length === newSi.length
      && savedSi.every(function (v, j) { return v === newSi[j]; });
    if (!match) {
      // 旧图配的 shotIndices 和新分组对不上 → 视为脏数据，清掉留待重生成
      project.storyboards[ck] = {};
      dirtyCleared++;
    }
  }
  if (dirtyCleared > 0) {
    console.log('[generateAllImages] cleared ' + dirtyCleared + ' stale storyboard slot(s) due to grouping change');
    saveProject();
    // 重渲一次让脏 slot 立即变回"待生成"占位
    try { renderImageGrid(); } catch (_) {}
  }

  var targets = [];
  for (var gk = 0; gk < groups.length; gk++) {
    var sb = project.storyboards[gk];
    if (!sb || (!sb.imageUrl && !sb.url)) {
      targets.push({ groupIdx: gk, idx: gk, shotIndices: groups[gk].shotIndices || [] });
    }
  }
  if (!targets.length) {
    // 所有组都有图——按旧语义还是重跑一遍（用户可能点了想重生成全部）
    targets = groups.map(function (g, idx) {
      return { groupIdx: idx, idx: idx, shotIndices: g.shotIndices || [] };
    });
  }
  var totalCount = targets.length;
  if (hint) hint.textContent = "正在生成 " + totalCount + " 张分镜图…";
  targets.forEach(function (t) { updateStoryboardCard(t.groupIdx, "loading", null, "生成分镜图中…"); });

  // —— 倒计时区域 ——
  // 用户反馈："这个位置改成倒计时吧 还有多久能生成完"。
  // 借用之前给"门控诊断"留的 #sbDiagnostic 容器，生成期间把它改成
  // 动态倒计时（done/total + 估算剩余秒数）；批次结束后清空。
  // 估算逻辑：等真实跑完 1 张以后用实测速度，否则给 70 秒/张的初始猜测
  //（gpt-image medium 实测）；后端并发 4 → 墙钟剩余时间 ≈ pending × avgSec ÷ 4。
  var diagBox = $("sbDiagnostic");
  var etaStartTs = Date.now();
  function _renderEta() {
    if (!diagBox) return;
    var done = doneCount;
    var fail = failCount;
    var pending = Math.max(0, totalCount - done - fail);
    var lines = ["生成中… " + done + "/" + totalCount];
    if (fail > 0) lines.push(fail + " 张失败");
    if (pending > 0) {
      var avg = (done + fail >= 1)
        ? (Date.now() - etaStartTs) / 1000 / (done + fail)
        : 70;
      var remain = Math.ceil(pending * avg / 4);
      lines.push("约剩 " + remain + " 秒");
    }
    diagBox.innerHTML = '<div class="diag-empty" style="text-align:center;padding:8px 0;font-weight:500;color:#475569;">' +
      escapeHtml(lines.join("，")) +
      '</div>';
  }
  function _clearEta() {
    if (!diagBox) return;
    // 批次结束后清空——后续门控诊断面板自己回填（如果有数据的话）
    diagBox.innerHTML = '';
  }
  _renderEta();
  // 兜底：定期 tick 让"约剩 N 秒"自然减少（即便 SSE / poll 没新事件）
  var etaTick = setInterval(_renderEta, 1000);
  function _stopEtaTick() { if (etaTick) { clearInterval(etaTick); etaTick = null; } }

  // seq -> groupIdx 反查，task_failed 缺 extra 时用
  var seqToGroupIdx = {};
  targets.forEach(function (t, seq) { seqToGroupIdx[seq] = t.groupIdx; });

  // Step 3：走后端 batch，无 fallback。/api/batch/start 失败直接报错，
  // 用户可重试或点单张重新生成；硬回滚靠 git revert。
  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'storyboard_images',
      projectId: originId,
      targets: targets,
    });
  } catch (e) {
    console.error('[generateAllImages] /api/batch/start failed:', e);
    if (e instanceof ApiError && e.errorCode === 'INSUFFICIENT_CREDITS') {
      if (hint) hint.textContent = '积分不足';
      showBillingPaywall(e.billing || null);
    } else {
      if (hint) hint.textContent = "启动失败：" + ((e && e.message) || e);
      showToast("批量生成启动失败：" + _diagnoseApiError(((e && e.message) || e).toString()), "error");
    }
    targets.forEach(function (t) { updateStoryboardCard(t.groupIdx, "error", null, "启动失败"); });
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
    return;
  }

  var doneCount = 0;
  var failCount = 0;
  var finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    _imagesGenerating = false;
    if (btn) btn.disabled = false;
    _stopEtaTick();
    _clearEta();
    var done = project.storyboards.filter(function (s) { return s && s.imageUrl; }).length;
    if (hint) hint.textContent = done + "/" + groups.length + " 张分镜图已生成";
    var allSbDone = groups.every(function (_, i) { return project.storyboards[i] && project.storyboards[i].imageUrl; });
    if (allSbDone && groups.length > 0) showToast("全部分镜图已生成", "success");
    if (failCount > 0) showToast(failCount + " 张分镜图生成失败，请手动重试", "warn");
    setTimeout(function () { _checkAndSuggest("images"); }, 1000);
  }

  // 已经在本地标记完成的 groupIdx —— polling/SSE 收到重复事件时去重
  var _seenDone = Object.create(null);
  var _seenFailed = Object.create(null);

  function _applyTaskCompleted(groupIdx, rawUrl, extra) {
    if (typeof groupIdx !== 'number' || !rawUrl) return;
    if (_seenDone[groupIdx]) return;  // 已处理过
    _seenDone[groupIdx] = true;
    doneCount++;

    var imageAssetId = (extra && extra.assetId) || '';
    var shotIndices = (extra && Array.isArray(extra.shotIndices)) ? extra.shotIndices : null;

    var isCurrent = _safeWriteBack(originId, function (proj) {
      if (!proj.storyboards) proj.storyboards = [];
      var existing = proj.storyboards[groupIdx] || {};
      _archiveOldImage(existing, "storyboard");
      existing.imageUrl = rawUrl;
      existing.rawUrl = rawUrl;
      if (imageAssetId) {
        existing.imageAssetId = imageAssetId;
        existing.fetchStatus = 'done';
      }
      if (shotIndices) existing.shotIndices = shotIndices;
      if (existing.realPhotoUrl) delete existing.realPhotoUrl;
      proj.storyboards[groupIdx] = existing;
      if (proj._staleFlags) delete proj._staleFlags["storyboard_" + groupIdx];
    });
    if (isCurrent) updateStoryboardCard(groupIdx, "done", rawUrl);
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
    _renderEta();
  }

  function _applyTaskFailed(groupIdx, errMsg) {
    if (typeof groupIdx !== 'number') return;
    if (_seenFailed[groupIdx] || _seenDone[groupIdx]) return;
    _seenFailed[groupIdx] = true;
    failCount++;
    updateStoryboardCard(groupIdx, "error", null, (errMsg || '生成失败').toString().slice(0, 120));
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
    _renderEta();
  }

  // ============================================================
  // 兜底轮询：每 5 秒主动 GET /api/batch/<id>，拿后端权威 snapshot。
  // SSE 在中转站 / 浏览器后台 / 反向代理下偶尔会丢事件，轮询保证 UI 最终
  // 能追上后端真实状态——哪怕 task_completed 一条都没收到，5 秒内也能恢复。
  // ============================================================
  var pollTimer = null;
  var pollSettled = false;
  function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function _pollOnce() {
    if (pollSettled) return;
    try {
      var snap = await apiGet("/api/batch/" + encodeURIComponent(startResp.batchId));
      if (!snap || pollSettled) return;
      var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
      tasks.forEach(function (t) {
        if (t.status === 'completed') {
          var result = t.result || {};
          var extra = result.extra || {};
          var patch = result.patch || {};
          var gIdx = (typeof extra.groupIdx === 'number')
            ? extra.groupIdx
            : ((t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq]);
          var url = extra.rawUrl || extra.url || patch.url || patch.rawUrl || result.resultUrl || '';
          _applyTaskCompleted(gIdx, url, extra);
        } else if (t.status === 'failed') {
          var gIdx2 = (t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq];
          _applyTaskFailed(gIdx2, t.errorMsg);
        }
      });
      if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') {
        console.log('[StoryboardImg] poll detected batch finished status=' + snap.status);
        pollSettled = true;
        _stopPoll();
        renderImageGrid();
        finish();
      }
    } catch (e) {
      console.warn('[StoryboardImg] poll failed:', (e && e.message) || e);
    }
  }
  pollTimer = setInterval(_pollOnce, 5000);

  subscribeBatch(startResp.batchId, {
    onSnapshot: function (snap) {
      if (hint && snap && typeof snap.total === 'number') {
        hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + snap.total;
      }
    },
    onTaskStarted: function (data) {
      var extra = data.target || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      if (typeof groupIdx === 'number' && !_seenDone[groupIdx]) {
        updateStoryboardCard(groupIdx, "loading", null, "生成中…");
      }
    },
    onTaskCompleted: function (data) {
      var extra = data.extra || {};
      var patch = data.patch || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      var rawUrl = extra.rawUrl || extra.url || patch.url || patch.rawUrl || patch.value || data.resultUrl || '';
      _applyTaskCompleted(groupIdx, rawUrl, extra);
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var groupIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      _applyTaskFailed(groupIdx, data.errorMsg);
    },
    onBatchCompleted: function () {
      pollSettled = true;
      _stopPoll();
      renderImageGrid();
      finish();
    },
    onClose: function () {
      // SSE 断开（非正常结束）：保留 polling，让它跑完所有 task
      // polling 自己会在 batch 真完成时调 finish
    },
  });
}

export function confirmImages() {
  if (!project || !project.shots) { showToast("请先生成分镜图", "warn"); return; }
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var missing = groups.filter(function (_, i) { return !project.storyboards[i] || !project.storyboards[i].imageUrl; });
  if (missing.length) { showToast("还有 " + missing.length + " 张分镜板未生成", "warn"); return; }
  project.imagesApproved = true;
  project.currentStep = Math.max(project.currentStep, 5);
  saveProject();
  switchPage("prompts");
}

export function handleImageAction(e) {
  if (!project) return;
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var action = btn.dataset.action;

  if (action === "lightbox") {
    var imgSrc = btn.tagName === "IMG" ? btn.src : (btn.dataset.img || "");
    if (imgSrc) _openLightbox(imgSrc);
    return;
  }

  var card = btn.closest(".sb-sheet");
  if (!card) return;
  var gIdx = parseInt(card.dataset.groupIdx, 10);

  if (action === "ref-agent-sb") {
    agentInsertRef("分镜板", String(gIdx + 1), { groupIdx: gIdx });
    return;
  }

  if (action === "show-history") {
    var sbItem = project.storyboards && project.storyboards[gIdx];
    if (!sbItem) { showToast("暂无历史版本", "warn"); return; }
    _openHistoryPopover(btn, sbItem, function (hi) {
      if (_setHistoryAsCurrent(sbItem, hi)) {
        saveProject();
        renderImageGrid();
        showToast("已恢复到历史版本", "ok");
      }
    });
    return;
  }

  if (action === "regen-sb") {
    if (_imagesGenerating) { showToast("正在生成中，请稍候", "warn"); return; }
    if (!project.storyboards) project.storyboards = [];
    var oldSb = project.storyboards[gIdx];
    if (oldSb) _archiveOldImage(oldSb, "storyboard");
    project.storyboards[gIdx] = oldSb && Array.isArray(oldSb.imageHistory) && oldSb.imageHistory.length
      ? { imageHistory: oldSb.imageHistory }
      : null;
    saveProject();
    generateStoryboardSheet(gIdx).then(function () {
      renderImageGrid();
      checkImagesConfirm();
    });
  } else if (action === "regen-sb-prompt") {
    if (_imagesGenerating || _promptsConverting) { showToast("正在生成中，请稍候", "warn"); return; }
    var groups = getStoryboardGroups();
    var group = groups[gIdx];
    if (!group) return;
    group.shotIndices.forEach(function (sIdx) {
      project.shots[sIdx].imagePrompt = "";
      project.shots[sIdx].imagePromptGenerated = false;
    });
    saveProject();
    updateStoryboardCard(gIdx, "loading", null, "重新生成提示词…");
    _autoConvertGroupPrompts(group).then(function () {
      updateStoryboardCard(gIdx, "loading", null, "重新生成分镜图…");
      return generateStoryboardSheet(gIdx);
    }).then(function () {
      renderImageGrid();
      checkImagesConfirm();
    }).catch(function (err) {
      showToast("重新生成失败: " + _diagnoseApiError(((err && err.message) || err).toString()), "error");
    });
  } else if (action === "download-sb") {
    var sb = project.storyboards && project.storyboards[gIdx];
    if (sb && sb.imageUrl) {
      var a = document.createElement("a");
      a.href = sb.imageUrl;
      a.download = "storyboard_" + (gIdx + 1) + ".png";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }
}

export function handleConvertAction(e) {
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var card = btn.closest(".prompt-preview-card");
  if (!card) return;
  var idx = parseInt(card.dataset.shotIdx, 10);
  var action = btn.dataset.action;

  if (action === "regen-convert") {
    if (_promptsConverting) { showToast("正在批量生成中，请稍候", "warn"); return; }
    if (!project || !project.shots[idx]) return;
    project.shots[idx].imagePrompt = "";
    project.shots[idx].imagePromptGenerated = false;
    saveProject();
    convertSinglePrompt(idx).then(function () { checkConvertConfirm(); });
  } else if (action === "edit-convert") {
    if (!project || !project.shots[idx]) return;
    var current = project.shots[idx].imagePrompt || "";
    var newPrompt = prompt("手动编辑图片提示词 (English):", current);
    if (newPrompt !== null && newPrompt.trim()) {
      project.shots[idx].imagePrompt = newPrompt.trim();
      project.shots[idx].imagePromptGenerated = true;
      var _editGIdxMap = _getShotGroupIndices();
      var _editGIdx = _editGIdxMap[idx] !== undefined ? _editGIdxMap[idx] : Math.floor(idx / 3);
      if (project.storyboards && project.storyboards[_editGIdx] && project.storyboards[_editGIdx].imageUrl) {
        if (!project._staleFlags) project._staleFlags = {};
        project._staleFlags["storyboard_" + _editGIdx] = true;
      }
      saveProject();
      renderPromptPreviewList();
      checkConvertConfirm();
    }
  }
}
