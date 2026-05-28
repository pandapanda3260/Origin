import { $, escapeHtml, showToast, showConfirm, apiPost, apiGet, apiPostStream, consumeStreamStepTags, hydrateProtectedImageElements, showConsistencyAggregateWarning } from './utils.js';
import { attachDiagnostic } from './diagnostic.js';
import { renderVpCard } from './render_hooks.js';
import { subscribeBatch } from './backend_stream.js';

let _ctx = {};
let project = null;
let settings = null;

let _videoPromptsGenerating = false;
let _vpSelectedGroup = 0;

const _VP_CACHE_VERSION = 2;
const _VP_EMPTY_CACHE = { version: _VP_CACHE_VERSION, text: '', segments: [], motionTags: [], sensitiveHits: [] };
let _vpInflight = {};
let _vpWarnedOnce = false;
let _vpAutoSaveTimer = null;
let _vpAutoSaveSeq = 0;
let _vpFlushPromises = {};
let _vpParseTimers = {};

const _HL_CLASS = {
  motion: 'font-bold border-b border-primary/30',
  style: 'italic text-on-surface-variant',
  bracket: 'font-black text-xs bg-on-background text-background px-1.5 py-0.5 rounded mr-1',
};

export function initVideoPrompts(ctx) {
  _ctx = ctx || {};
  _syncRefs();
}

export function syncVideoPromptsProject(p) {
  project = p || null;
  settings = _ctx.getSettings ? _ctx.getSettings() : settings;
}

function _syncRefs() {
  project = _ctx.getProject ? _ctx.getProject() : project;
  settings = _ctx.getSettings ? _ctx.getSettings() : settings;
}
function _invalidateVideoForGroup(gIdx, sb) {
  var now = new Date().toISOString();
  if (sb) {
    sb.videoIsCurrent = false;
    sb.videoInvalidatedAt = now;
    sb.videoInvalidatedReason = "video_prompt_regeneration";
  }
  if (project && Array.isArray(project.videoTasks) && project.videoTasks.length > gIdx && project.videoTasks[gIdx]) {
    project.videoTasks[gIdx].isCurrent = false;
    project.videoTasks[gIdx].invalidatedAt = now;
    project.videoTasks[gIdx].invalidatedReason = "video_prompt_regeneration";
  }
}

function _setVideoPromptStatus(gIdx, status, extra) {
  if (!project.storyboards) project.storyboards = [];
  if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
  var sb = project.storyboards[gIdx];
  var now = new Date().toISOString();
  sb.videoPromptStatus = status;
  if (extra && extra.videoPromptRunId) sb.videoPromptRunId = extra.videoPromptRunId;
  if (status === "ready") {
    sb.videoPromptUpdatedAt = now;
    delete sb.videoPromptFailedAt;
    delete sb.videoPromptLastError;
  } else if (status === "generating") {
    sb.videoPromptStartedAt = now;
    delete sb.videoPromptFailedAt;
    delete sb.videoPromptLastError;
  } else if (status === "failed") {
    sb.videoPromptFailedAt = now;
    sb.videoPromptLastError = (extra && extra.errorMsg) || "生成失败";
  }
}

function _isStillOwnerOfShot(gIdx, ourRunId) {
  if (!ourRunId) return true;
  var current = project && project.storyboards && project.storyboards[gIdx];
  var currentRunId = current && current.videoPromptRunId;
  if (!currentRunId) return true;
  return currentRunId === ourRunId;
}

async function _reloadVideoPromptProjectFromServer() {
  if (!_ctx.reloadProjectFromServer) return false;
  try {
    await _vpFlushAutoSave(_vpSelectedGroup);
    var ok = await _ctx.reloadProjectFromServer();
    _syncRefs();
    var storyboards = project && Array.isArray(project.storyboards) ? project.storyboards : [];
    if (_vpSelectedGroup >= storyboards.length) _vpSelectedGroup = 0;
    try { renderVideoPromptList({ force: true }); } catch (_renderErr) {}
    try { _renderVpStoryboardFrames(); } catch (_framesErr) {}
    return ok !== false;
  } catch (e) {
    console.warn('[VideoPrompt] reloadProjectFromServer failed:', e);
    return false;
  }
}

function _isVideoPromptReady(sb) {
  if (!sb || !sb.videoPrompt) return false;
  if (!sb.videoPromptStatus) return true;
  return sb.videoPromptStatus === "ready";
}

function _videoPromptUiState(sb) {
  var hasPrompt = !!(sb && sb.videoPrompt && String(sb.videoPrompt).trim());
  var status = sb && sb.videoPromptStatus;
  if (status === "generating") {
    return {
      label: "生成中",
      hint: "当前片段的视频提示词正在生成。",
      canGenerate: false,
      tone: "muted",
    };
  }
  if (hasPrompt) {
    return { label: "重新生成提示词", hint: "", canGenerate: true, tone: "ready" };
  }
  if (status === "failed") {
    return { label: "重新生成提示词", hint: "上次生成失败，可以重新生成。", canGenerate: true, tone: "error" };
  }
  return { label: "生成提示词", hint: "当前片段还没有视频提示词。", canGenerate: true, tone: "missing" };
}

function _videoPromptStatusBadge(sb) {
  if (_isVideoPromptReady(sb)) {
    return '<span class="text-[10px] bg-green-400/15 text-green-700 px-2 py-1 rounded-full font-bold">已生成</span>';
  }
  if (sb && sb.videoPromptStatus === "generating") {
    return '<span class="text-[10px] bg-primary/10 text-primary px-2 py-1 rounded-full font-bold">生成中</span>';
  }
  if (sb && sb.videoPromptStatus === "failed") {
    return '<span class="text-[10px] bg-error/10 text-error px-2 py-1 rounded-full font-bold">失败</span>';
  }
  return '<span class="text-[10px] bg-surface-container-highest text-on-surface-variant px-2 py-1 rounded-full font-bold">待生成</span>';
}

function _missingVideoPromptLabels(groups) {
  var labels = [];
  for (var i = 0; i < groups.length; i++) {
    var sb = project && project.storyboards && project.storyboards[i];
    if (!_isVideoPromptReady(sb)) labels.push(String(i + 1));
  }
  return labels;
}

function _areAllVideoPromptsReady(groups) {
  return !!(groups && groups.length) && groups.every(function (_, i) {
    return _isVideoPromptReady(project && project.storyboards && project.storyboards[i]);
  });
}

function _shouldBatchTargetVideoPrompt(sb, regenerateAll) {
  if (regenerateAll) return true;
  if (!sb) return true;
  if (_isVideoPromptReady(sb)) return false;
  if (sb.videoPromptStatus === "generating") return false;
  return true;
}

function _setVideoPromptBulkButtonLabel(text) {
  var label = $("btnGenAllVideoPromptsLabel");
  if (label) label.textContent = text;
}

function _setVideoPromptBulkButtonDisabled(disabled) {
  var btn = $("btnGenAllVideoPrompts");
  if (btn) btn.disabled = !!disabled;
}

function _updateVideoPromptBulkButtonLabel(groups) {
  if (_videoPromptsGenerating) {
    _setVideoPromptBulkButtonLabel("生成中…");
    _setVideoPromptBulkButtonDisabled(true);
    return;
  }
  var gs = groups || getStoryboardGroups();
  // 空项目兜底：通常按钮根本不会被渲染到，但 label 函数也可能被其它路径调到——
  // 不要让它在 storyboards=[] 时错判成"生成中…disabled"。
  if (!gs.length) {
    _setVideoPromptBulkButtonLabel("生成全部提示词");
    _setVideoPromptBulkButtonDisabled(false);
    return;
  }
  if (_areAllVideoPromptsReady(gs)) {
    _setVideoPromptBulkButtonLabel("重新生成全部提示词");
    _setVideoPromptBulkButtonDisabled(false);
    return;
  }
  var regenerateAll = false;
  var targetCount = gs.filter(function (_, i) {
    return _shouldBatchTargetVideoPrompt(project && project.storyboards && project.storyboards[i], regenerateAll);
  }).length;
  if (targetCount === 0) {
    _setVideoPromptBulkButtonLabel("生成中…");
    _setVideoPromptBulkButtonDisabled(true);
    return;
  }
  if (targetCount >= gs.length) {
    _setVideoPromptBulkButtonLabel("生成全部提示词");
    _setVideoPromptBulkButtonDisabled(false);
    return;
  }
  _setVideoPromptBulkButtonLabel("生成剩余 " + targetCount + " 条提示词");
  _setVideoPromptBulkButtonDisabled(false);
}

function _updateVideoPromptConfirmButton(groups) {
  var area = $("videoPromptsConfirmTopArea");
  var btn = $("btnConfirmVideoPromptsTop");
  if (!area || !btn) return;
  var allDone = _areAllVideoPromptsReady(groups || getStoryboardGroups());
  area.hidden = false;
  btn.disabled = !allDone;
  // 用 innerHTML 整段重写，保留前置语义 icon + 末尾箭头；如果只 setText 会把 workspace.html
  // 里的 <span class="material-symbols-outlined"> 子节点冲掉，导致 icon 一刷新就丢。
  btn.innerHTML =
    '<span class="material-symbols-outlined text-base">auto_awesome</span>' +
    '<span>确认提示词，进入下一步</span>' +
    '<span class="material-symbols-outlined text-base">arrow_forward</span>';
  btn.classList.toggle("opacity-50", !allDone);
  btn.classList.toggle("cursor-not-allowed", !allDone);
  btn.classList.toggle("shadow-none", !allDone);
  btn.classList.toggle("hover:opacity-90", allDone);
  btn.classList.toggle("hover:opacity-50", !allDone);
}

function saveProject() { if (_ctx.saveProject) return _ctx.saveProject(); }
function _safeWriteBack(originId, fn, serverVersion) { return _ctx.safeWriteBack ? _ctx.safeWriteBack(originId, fn, serverVersion) : false; }
function getStoryboardGroups() { return _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : []; }
function agentInsertRef(type, label, data) { if (_ctx.agentInsertRef) _ctx.agentInsertRef(type, label, data); }
function _isStale(key) { return _ctx.isStale ? _ctx.isStale(key) : false; }
function _clearStale(key) { if (_ctx.clearStale) _ctx.clearStale(key); }
function _checkAndSuggest(stage) { if (_ctx.checkAndSuggest) _ctx.checkAndSuggest(stage); }
function switchPage(page) { if (_ctx.switchPage) _ctx.switchPage(page); }
function formatCreatorProfileForApi() { return _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null; }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }

function _videoPromptErrorMeta(err) {
  var payload = err && err.payload;
  return {
    errorCode: (err && err.errorCode) || (payload && payload.errorCode) || "",
    failureStage: (err && err.failureStage) || (payload && payload.failureStage) || "",
    skippedReason: (err && err.skippedReason) || (payload && payload.skippedReason) || "",
    failureApplied: (payload && Object.prototype.hasOwnProperty.call(payload, 'failureApplied')) ? payload.failureApplied : undefined,
    videoPromptRunId: (payload && payload.videoPromptRunId) || "",
    storedRunId: (payload && payload.storedRunId) || "",
  };
}

function _isVideoPromptOwnershipMeta(meta) {
  if (!meta) return false;
  var errorCode = meta.errorCode || "";
  return errorCode === 'VIDEO_PROMPT_RUN_TAKEN_BY_OTHER' ||
    errorCode === 'VIDEO_PROMPT_RUN_MISMATCH' ||
    meta.skippedReason === 'run_taken_by_other';
}

function _classifyVideoPromptFailureKind(errMsg, meta) {
  var msg = String(errMsg || '');
  var errorCode = meta && meta.errorCode;
  var failureStage = meta && meta.failureStage;
  if (errorCode === 'VIDEO_PROMPT_CONSISTENCY_GATE_FAILED') return 'character';
  if (errorCode === 'VIDEO_PROMPT_RUN_TAKEN_BY_OTHER' || errorCode === 'VIDEO_PROMPT_RUN_MISMATCH') return 'ownership';
  if (errorCode === 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED') return 'writeback';
  if (errorCode === 'VIDEO_PROMPT_EMPTY_RESULT') return 'empty';
  if (errorCode === 'VIDEO_PROMPT_PROJECT_NOT_FOUND') return 'project';
  if (errorCode === 'VIDEO_PROMPT_LLM_FAILED') return 'model';
  if (failureStage === 'consistency') return 'character';
  if (failureStage === 'persist') return 'writeback';
  if (/角色一致性|needs_review|species|character/i.test(msg)) return 'character';
  if (/返回为空|没有返回|empty/i.test(msg)) return 'empty';
  return 'model';
}

function _singleVideoPromptFailureMessage(errMsg, meta) {
  var errorCode = meta && meta.errorCode;
  if (errorCode === 'VIDEO_PROMPT_RUN_TAKEN_BY_OTHER' || errorCode === 'VIDEO_PROMPT_RUN_MISMATCH') {
    return "这条提示词结果已过期，当前镜头已有新的生成任务";
  }
  if (errorCode === 'VIDEO_PROMPT_CONSISTENCY_GATE_FAILED') {
    return "提示词未通过角色一致性检查，请调整角色或重新生成";
  }
  if (errorCode === 'VIDEO_PROMPT_WRITEBACK_NOT_APPLIED') {
    return "提示词生成完成但保存失败，请重试";
  }
  if (errorCode === 'VIDEO_PROMPT_EMPTY_RESULT') {
    return "AI 返回为空，请重新生成";
  }
  if (errorCode === 'VIDEO_PROMPT_PROJECT_NOT_FOUND') {
    return "项目已不存在或无法访问，请刷新项目列表";
  }
  if (errorCode === 'VIDEO_PROMPT_LLM_FAILED') {
    return "模型生成失败，请重试";
  }
  var diagnosed = _diagnoseApiError(errMsg);
  if (/video_prompt_generating/i.test(String(diagnosed || ''))) {
    return "当前镜头的视频提示词仍在生成中，请稍后再试";
  }
  return diagnosed || "模型生成失败，请重试";
}

function _getVideoPromptPreflightPayload(err) {
  var payload = err && err.payload;
  if (!payload || !payload.preflight) return null;
  if (payload.code === "video_prompt_preflight_failed") return payload;
  if (payload.preflight && payload.preflight.allowed === false) return payload;
  return null;
}

function _formatVideoPromptPreflightMessage(payload) {
  var preflight = (payload && payload.preflight) || {};
  var blocked = Array.isArray(preflight.blocked) ? preflight.blocked : [];
  if (!blocked.length) return (payload && (payload.detail || payload.error)) || "视频提示词生成前检查未通过";

  var segments = blocked.map(function (item) { return (item.groupIdx + 1); });
  var seenSegments = {};
  segments = segments.filter(function (n) {
    if (seenSegments[n]) return false;
    seenSegments[n] = true;
    return true;
  });

  var byCharacter = {};
  blocked.forEach(function (item) {
    (item.blockers || []).forEach(function (blocker) {
      var name = blocker.characterName || blocker.characterId || "角色";
      if (!byCharacter[name]) byCharacter[name] = { confirm: false, species: false, messages: [] };
      if (blocker.code === "character_status_not_locked") byCharacter[name].confirm = true;
      else if (blocker.code === "nonhuman_species_missing") byCharacter[name].species = true;
      else if (blocker.message) byCharacter[name].messages.push(blocker.message);
    });
  });

  var characterLines = Object.keys(byCharacter).map(function (name) {
    var item = byCharacter[name];
    var actions = [];
    if (item.confirm) actions.push("需要确认锁定");
    if (item.species) actions.push("缺少物种");
    item.messages.forEach(function (msg) { if (actions.indexOf(msg) < 0) actions.push(msg); });
    return name + "：" + (actions.join("，") || "需要检查");
  });

  var msg = "生成前需要先确认角色一致性。请去「资产库」确认角色锁；非人角色缺少物种时先补 species。\n";
  msg += "受影响片段：" + segments.join("、") + "\n\n";
  msg += characterLines.slice(0, 6).join("\n");
  if (characterLines.length > 6) msg += "\n还有 " + (characterLines.length - 6) + " 个角色需要检查";
  return msg;
}

function _videoPromptPreflightHint(payload) {
  var blocked = payload && payload.preflight && Array.isArray(payload.preflight.blocked)
    ? payload.preflight.blocked
    : [];
  if (!blocked.length) return "生成前检查未通过";
  var characterNames = {};
  blocked.forEach(function (item) {
    (item.blockers || []).forEach(function (blocker) {
      var name = blocker.characterName || blocker.characterId;
      if (name) characterNames[name] = true;
    });
  });
  var names = Object.keys(characterNames);
  if (names.length) return "生成前检查未通过：" + names.join("、") + " 需要先确认";
  return "生成前检查未通过：" + blocked.length + " 个片段需要先处理";
}

function _suggestSpeciesForCharacterName(name) {
  var text = String(name || '').normalize('NFKC').toLowerCase();
  if (/孙悟空|猴|monkey|ape/.test(text)) return "monkey";
  if (/猪八戒|猪|pig|boar/.test(text)) return "pig";
  if (/龙|dragon/.test(text)) return "dragon";
  if (/狐|狐狸|fox/.test(text)) return "fox";
  if (/狗|犬|dog/.test(text)) return "dog";
  if (/猫|cat/.test(text)) return "cat";
  if (/鸟|bird/.test(text)) return "bird";
  if (/蟹|crab/.test(text)) return "crab";
  if (/虾|shrimp/.test(text)) return "shrimp";
  if (/机器人|机甲|robot|mech/.test(text)) return "robot";
  return "";
}

function _collectVideoPromptPreflightFixes(payload) {
  var blocked = payload && payload.preflight && Array.isArray(payload.preflight.blocked)
    ? payload.preflight.blocked
    : [];
  var byKey = {};
  blocked.forEach(function (item) {
    (item.blockers || []).forEach(function (blocker) {
      if (blocker.code !== "character_status_not_locked" && blocker.code !== "nonhuman_species_missing") return;
      var id = blocker.characterId || "";
      var name = blocker.characterName || id || "角色";
      var key = id || name;
      if (!byKey[key]) {
        byKey[key] = {
          characterId: id,
          characterName: name,
          needsConfirm: false,
          needsSpecies: false,
          species: "",
        };
      }
      if (blocker.code === "character_status_not_locked") byKey[key].needsConfirm = true;
      if (blocker.code === "nonhuman_species_missing") {
        byKey[key].needsSpecies = true;
        byKey[key].species = byKey[key].species || _suggestSpeciesForCharacterName(name);
      }
    });
  });

  var fixes = Object.keys(byKey).map(function (key) { return byKey[key]; });
  var canAutoFix = fixes.length > 0 && fixes.every(function (fix) {
    return !fix.needsSpecies || !!fix.species;
  });
  return { fixes: fixes, canAutoFix: canAutoFix };
}

function _formatVideoPromptAutoFixMessage(fixPlan) {
  if (!fixPlan || !fixPlan.fixes || !fixPlan.fixes.length || !fixPlan.canAutoFix) return "";
  var lines = fixPlan.fixes.map(function (fix) {
    var actions = [];
    if (fix.needsSpecies) actions.push("物种 " + fix.species);
    if (fix.needsConfirm) actions.push("确认锁定");
    return fix.characterName + "：" + actions.join("，");
  });
  return "\n\n可自动处理：\n" + lines.join("\n");
}

async function _applyVideoPromptPreflightFixes(fixPlan) {
  if (!project || !project.id || !fixPlan || !fixPlan.canAutoFix) return false;
  var fixes = fixPlan.fixes.map(function (fix) {
    return {
      characterId: fix.characterId,
      characterName: fix.characterName,
      species: fix.species,
    };
  });
  var resp = await apiPost(
    "/api/projects/" + encodeURIComponent(project.id) + "/character-consistency/confirm",
    { fixes: fixes },
  );
  if (resp && resp.project) {
    if (_ctx.applyProjectFromServer) _ctx.applyProjectFromServer(resp.project);
    project = resp.project;
    _syncRefs();
    renderVideoPromptList();
    _renderVpStoryboardFrames();
    checkVideoPromptsConfirm();
  } else if (_ctx.reloadProjectFromServer) {
    await _ctx.reloadProjectFromServer();
    _syncRefs();
  }
  return true;
}

async function _handleVideoPromptPreflightBlocked(payload, runOpts, hint, btn) {
  var fixPlan = _collectVideoPromptPreflightFixes(payload);
  var canAutoFix = fixPlan.canAutoFix && !(runOpts && runOpts.skipAutoFix);
  var msg = _formatVideoPromptPreflightMessage(payload) + _formatVideoPromptAutoFixMessage(fixPlan);
  var okText = canAutoFix ? "确认并继续生成" : "去资产页";
  var ok = await showConfirm("生成前需要确认角色", msg, okText, "稍后处理");
  if (!ok) return;
  if (!canAutoFix) {
    switchPage("assets");
    return;
  }
  try {
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = "正在确认角色信息…";
    await _applyVideoPromptPreflightFixes(fixPlan);
    showToast("角色信息已确认，继续生成视频提示词", "ok");
    generateAllVideoPrompts({ __videoPromptRunOptions: true, skipAutoFix: true });
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString();
    if (hint) hint.textContent = "角色确认失败：" + errMsg;
    showToast("角色确认失败：" + _diagnoseApiError(errMsg), "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function getVpSelectedGroup() { return _vpSelectedGroup; }
export function setVpSelectedGroup(idx) { _vpSelectedGroup = idx; }

/* ================================================================
   VP Cache
   ================================================================ */
function _vpHasDraft(sb) {
  return !!(sb && sb.videoPromptEditDraft && Object.prototype.hasOwnProperty.call(sb.videoPromptEditDraft, 'content'));
}

function _vpHasUsableDraft(sb) {
  return !!(_vpHasDraft(sb) && String(sb.videoPromptEditDraft.content == null ? '' : sb.videoPromptEditDraft.content).trim());
}

function _vpCurrentText(sb) {
  if (_vpHasDraft(sb)) return String(sb.videoPromptEditDraft.content == null ? '' : sb.videoPromptEditDraft.content);
  return String((sb && sb.videoPrompt) || '');
}

function _vpCurrentSource(sb) {
  return _vpHasDraft(sb) ? 'draft' : 'prompt';
}

function _vpDraftFingerprint(sb) {
  return (sb && sb.videoPromptEditDraft && sb.videoPromptEditDraft.savedDraftFingerprint) || '';
}

function _vpIsSavedDraftChanged(err) {
  var payload = err && err.payload;
  var code = payload && (payload.code || payload.errorCode);
  return code === 'saved_draft_changed';
}

function _vpEnsureLocalDraft(gIdx, content) {
  if (!project.storyboards) project.storyboards = [];
  if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
  var sb = project.storyboards[gIdx];
  var existing = sb.videoPromptEditDraft || {};
  sb.videoPromptEditDraft = {
    content: String(content == null ? '' : content),
    sourceHash: Object.prototype.hasOwnProperty.call(existing, 'sourceHash') ? existing.sourceHash : (sb.videoPromptSourceHash || null),
    savedDraftFingerprint: existing.savedDraftFingerprint || '',
    updatedAt: new Date().toISOString(),
  };
  return sb.videoPromptEditDraft;
}

function _vpSetDraftStatus(text, tone) {
  var el = $("vpDraftStatus");
  if (!el) return;
  el.textContent = text || '';
  el.className = "text-[11px] font-medium " + (
    tone === 'error' ? 'text-error' :
    tone === 'ok' ? 'text-green-700' :
    'text-on-surface-variant/70'
  );
}

function _vpCacheKey(sb, text) {
  var key = sb._vpKey || (sb._vpKey = 'vp_' + Math.random().toString(36).slice(2, 10));
  var raw = String(text || '');
  var h = 0;
  for (var i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  return key + ':' + raw.length + ':' + h;
}

export function vpCacheValid(cache, text) {
  return !!(cache && cache.version === _VP_CACHE_VERSION && cache.text === text);
}

export function vpGetCache(sb) {
  if (!sb) return _VP_EMPTY_CACHE;
  var text = _vpCurrentText(sb);
  if (vpCacheValid(sb._vpCache, text)) return sb._vpCache;
  return _VP_EMPTY_CACHE;
}

export async function vpFetchAndCache(sb, textOverride) {
  if (!sb) return _VP_EMPTY_CACHE;
  var text = textOverride == null ? _vpCurrentText(sb) : String(textOverride || '');
  if (vpCacheValid(sb._vpCache, text)) return sb._vpCache;
  if (!text) {
    sb._vpCache = { version: _VP_CACHE_VERSION, text: '', segments: [], motionTags: [], sensitiveHits: [] };
    return sb._vpCache;
  }
  try {
    var resp = await apiPost('/api/prompt/parse', { text: text });
    sb._vpCache = {
      version: _VP_CACHE_VERSION,
      text: text,
      segments: resp.segments || [],
      motionTags: resp.motionTags || [],
      sensitiveHits: resp.sensitiveHits || [],
    };
  } catch (e) {
    var status = (e && (e.status || e.code)) || '?';
    var msg = (e && (e.message || e.statusText)) || String(e);
    console.error('[VpParse] /api/prompt/parse failed status=' + status + ' msg=' + msg, e);
    if (!_vpWarnedOnce) {
      _vpWarnedOnce = true;
      try { showToast('提示词解析接口异常，标签与敏感词检测已降级', 'warn'); } catch (_) {}
    }
    sb._vpCache = {
      version: _VP_CACHE_VERSION,
      text: text,
      segments: [{ time: '', text: text }],
      motionTags: [],
      sensitiveHits: [],
    };
  }
  return sb._vpCache;
}

function _vpEnsureCache(sb, onReady) {
  if (!sb) return _VP_EMPTY_CACHE;
  var text = _vpCurrentText(sb);
  if (vpCacheValid(sb._vpCache, text)) return sb._vpCache;
  var key = _vpCacheKey(sb, text);
  if (!_vpInflight[key]) {
    _vpInflight[key] = vpFetchAndCache(sb, text)
      .then(function (cache) {
        delete _vpInflight[key];
        if (cache && cache.text === _vpCurrentText(sb) && typeof onReady === 'function') onReady(cache);
        return cache;
      })
      .catch(function (err) { delete _vpInflight[key]; throw err; });
  } else if (typeof onReady === 'function') {
    _vpInflight[key].then(onReady);
  }
  return sb._vpCache || _VP_EMPTY_CACHE;
}

function _vpScheduleParse(gIdx) {
  clearTimeout(_vpParseTimers[gIdx]);
  _vpParseTimers[gIdx] = setTimeout(function () {
    var sb = project && project.storyboards && project.storyboards[gIdx];
    if (!sb) return;
    _vpEnsureCache(sb, function () {
      if (gIdx === _vpSelectedGroup) updateVideoPromptChrome(gIdx);
    });
    if (gIdx === _vpSelectedGroup) updateVideoPromptChrome(gIdx);
  }, 450);
}

async function _vpSaveDraftNow(gIdx, content, opts) {
  opts = opts || {};
  _syncRefs();
  if (!project || !project.id || !project.storyboards || !project.storyboards[gIdx]) return null;
  var sb = project.storyboards[gIdx];
  var expected = opts.force ? '' : _vpDraftFingerprint(sb);
  var resp = await apiPost('/api/video-prompt/edit-draft', {
    projectId: project.id,
    groupIdx: gIdx,
    draft: { content: String(content == null ? '' : content) },
    expectedSavedDraftFingerprint: expected,
    force: opts.force === true,
  }, 'PUT');
  if (project && project.storyboards && project.storyboards[gIdx] && resp && resp.draft) {
    project.storyboards[gIdx].videoPromptEditDraft = resp.draft;
  }
  return resp;
}

function _vpScheduleAutoSave(gIdx) {
  clearTimeout(_vpAutoSaveTimer);
  _vpSetDraftStatus('正在保存…');
  _vpAutoSaveTimer = setTimeout(function () {
    _vpFlushAutoSave(gIdx).catch(function (e) {
      console.warn('[VideoPromptDraft] autosave failed:', e);
    });
  }, 650);
}

export async function _vpFlushAutoSave(gIdx) {
  _syncRefs();
  if (!project || !project.storyboards) return true;
  var idx = Number.isInteger(gIdx) ? gIdx : _vpSelectedGroup;
  if (_vpFlushPromises[idx]) {
    return _vpFlushPromises[idx].then(function (result) {
      var sbAfter = project && project.storyboards && project.storyboards[idx];
      if (result && sbAfter && _vpHasDraft(sbAfter) && sbAfter._vpDraftLastSavedContent !== _vpCurrentText(sbAfter)) {
        return _vpFlushAutoSave(idx);
      }
      return result;
    });
  }
  _vpFlushPromises[idx] = _vpFlushAutoSaveOnce(idx).finally(function () {
    delete _vpFlushPromises[idx];
  });
  return _vpFlushPromises[idx];
}

async function _vpFlushAutoSaveOnce(idx) {
  var sb = project.storyboards[idx];
  if (!sb || !_vpHasDraft(sb)) return true;
  clearTimeout(_vpAutoSaveTimer);
  var content = _vpCurrentText(sb);
  if (sb._vpDraftLastSavedContent === content && _vpDraftFingerprint(sb)) {
    _vpSetDraftStatus('草稿已保存', 'ok');
    return true;
  }
  var seq = ++_vpAutoSaveSeq;
  sb._vpDraftSaveSeq = seq;
  _vpSetDraftStatus('正在保存…');
  try {
    var resp = await _vpSaveDraftNow(idx, content, { force: false });
    _vpApplySavedDraftResponse(idx, content, seq, resp);
    return true;
  } catch (e) {
    if (_vpIsSavedDraftChanged(e)) {
      var overwrite = await showConfirm(
        '草稿已在其他位置修改',
        '当前视频提示词草稿被其他窗口或设备更新过。是否用本页正在编辑的内容覆盖它？',
        '覆盖保存',
        '先不覆盖',
      );
      if (!overwrite) {
        _vpSetDraftStatus('草稿未覆盖');
        return false;
      }
      try {
        var forcedResp = await _vpSaveDraftNow(idx, content, { force: true });
        _vpApplySavedDraftResponse(idx, content, seq, forcedResp);
        return true;
      } catch (retryErr) {
        e = retryErr;
      }
    }
    _vpSetDraftStatus('草稿保存失败', 'error');
    showToast('视频提示词草稿保存失败：' + _diagnoseApiError(((e && e.message) || e).toString()), 'error');
    return false;
  }
}

function _vpApplySavedDraftResponse(idx, content, seq, resp) {
  if (project && project.storyboards && project.storyboards[idx]) {
    var currentSb = project.storyboards[idx];
    if (currentSb._vpDraftSaveSeq === seq) {
      currentSb._vpDraftLastSavedContent = content;
      _vpSetDraftStatus('草稿已保存', 'ok');
    }
    if (resp && resp.draft) currentSb.videoPromptEditDraft = resp.draft;
  }
}

export async function flushVideoPromptAutoSave() {
  return _vpFlushAutoSave(_vpSelectedGroup);
}

async function _vpCommitDraft(gIdx, opts) {
  opts = opts || {};
  _syncRefs();
  if (!project || !project.id || !project.storyboards || !project.storyboards[gIdx]) return true;
  var sb = project.storyboards[gIdx];
  if (!_vpHasDraft(sb)) return true;
  if (!_vpHasUsableDraft(sb)) {
    showToast('视频提示词草稿为空，不能确认使用', 'warn');
    return false;
  }
  var flushed = await _vpFlushAutoSave(gIdx);
  if (!flushed && !opts.force) return false;
  var current = project.storyboards[gIdx] || sb;
  if (!_vpHasDraft(current)) return true;
  if (!_vpHasUsableDraft(current)) {
    showToast('视频提示词草稿为空，不能确认使用', 'warn');
    return false;
  }
  try {
    var resp = await apiPost('/api/video-prompt/commit-draft', {
      projectId: project.id,
      groupIdx: gIdx,
      expectedSavedDraftFingerprint: _vpDraftFingerprint(current),
      force: opts.force === true,
    });
    if (project && project.storyboards && project.storyboards[gIdx]) {
      project.storyboards[gIdx].videoPrompt = resp.videoPrompt || _vpCurrentText(project.storyboards[gIdx]);
      project.storyboards[gIdx].videoPromptSourceHash = resp.videoPromptSourceHash || null;
      project.storyboards[gIdx].videoPromptRunId = resp.videoPromptRunId || project.storyboards[gIdx].videoPromptRunId;
      project.storyboards[gIdx].videoPromptStatus = 'ready';
      project.storyboards[gIdx].videoPromptUpdatedAt = new Date().toISOString();
      delete project.storyboards[gIdx].videoPromptEditDraft;
      delete project.storyboards[gIdx].videoPromptFailedAt;
      delete project.storyboards[gIdx].videoPromptLastError;
      project.storyboards[gIdx]._vpCache = null;
      _invalidateVideoForGroup(gIdx, project.storyboards[gIdx]);
      _clearStale("video_prompt_" + gIdx);
    }
    return true;
  } catch (e) {
    if (_vpIsSavedDraftChanged(e) && !opts.force) {
      var overwrite = await showConfirm(
        '草稿已在其他位置修改',
        '当前视频提示词草稿被其他窗口或设备更新过。是否用本页正在编辑的内容覆盖并继续确认使用？',
        '覆盖并确认',
        '先不覆盖',
      );
      if (overwrite) return _vpCommitDraft(gIdx, { force: true });
      return false;
    }
    showToast('提交视频提示词草稿失败：' + _diagnoseApiError(((e && e.message) || e).toString()), 'error');
    return false;
  }
}

async function _vpCommitAllDrafts() {
  if (!project || !project.storyboards) return true;
  await _vpFlushAutoSave(_vpSelectedGroup);
  for (var i = 0; i < project.storyboards.length; i++) {
    if (_vpHasDraft(project.storyboards[i])) {
      var ok = await _vpCommitDraft(i);
      if (!ok) return false;
    }
  }
  return true;
}

/* ================================================================
   Page render
   ================================================================ */
export function refreshPromptsPage() {
  _syncRefs();
  var needImages = $("promptsNeedImages");
  var narrativePanel = $("promptsNarrativePanel");
  var labPanel = $("promptsLabPanel");
  var ready = $("promptsReady");
  var tag = $("vpVersionTag");
  if (!project || !project.shots || !project.shots.length) {
    if (needImages) needImages.hidden = false;
    if (narrativePanel) narrativePanel.hidden = true;
    if (labPanel) labPanel.hidden = true;
    if (ready) ready.hidden = true;
    if (tag) {
      tag.textContent = "";
      tag.hidden = true;
    }
    var vf = $("vpStoryboardFrames"); if (vf) vf.innerHTML = "";
    var vl = $("videoPromptList"); if (vl) vl.innerHTML = "";
    return;
  }
  if (needImages) needImages.hidden = true;
  if (narrativePanel) narrativePanel.hidden = false;
  if (labPanel) labPanel.hidden = false;
  if (ready) ready.hidden = false;
  _vpSelectedGroup = Math.min(_vpSelectedGroup, Math.max(0, getStoryboardGroups().length - 1));
  _renderVpStoryboardFrames();
  renderVideoPromptList();
  _updateVideoPromptBulkButtonLabel();
  checkVideoPromptsConfirm();
}

// 片段条展示导演计划时长：直接累加镜头表里的 duration。
// 真实生成文件可能因为供应商最小时长略长，剪辑页会读取 videoDurationSec 再处理。
function _plannedGroupDuration(group) {
  var total = 0;
  (group.shots || []).forEach(function (sh) {
    total += Number((sh && (sh.duration || sh.durationSec)) || 4) || 4;
  });
  return Math.max(1, Math.round(total * 10) / 10);
}

function _vpNormalizedShotIndices(group) {
  var raw = Array.isArray(group && group.shotIndices) ? group.shotIndices : [];
  return raw
    .map(function (idx) { return Number(idx); })
    .filter(function (idx) { return Number.isFinite(idx) && idx >= 0; })
    .sort(function (a, b) { return a - b; });
}

function _vpShotCount(groups) {
  var seen = {};
  var total = 0;
  (groups || []).forEach(function (group) {
    var indices = _vpNormalizedShotIndices(group);
    if (indices.length) {
      indices.forEach(function (idx) {
        if (seen[idx]) return;
        seen[idx] = true;
        total += 1;
      });
      return;
    }
    total += Array.isArray(group && group.shots) ? group.shots.length : 0;
  });
  if (!total && project && Array.isArray(project.shots)) total = project.shots.length;
  return total;
}

function _vpShotNumberLabel(group, fallbackIdx) {
  var indices = _vpNormalizedShotIndices(group);
  if (!indices.length) return "镜头 " + String((fallbackIdx || 0) + 1).padStart(2, "0");
  var nums = indices.map(function (idx) { return String(idx + 1).padStart(2, "0"); });
  if (nums.length <= 3) return "镜头 " + nums.join("、");
  return "镜头 " + nums[0] + "-" + nums[nums.length - 1];
}

function _renderVpStoryboardFrames() {
  var container = $("vpStoryboardFrames");
  if (!container) return;
  container.innerHTML = "";
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var tag = $("vpVersionTag");
  if (tag) {
    tag.hidden = false;
    tag.textContent = _vpShotCount(groups) + "个镜头/" + groups.length + "个片段";
  }

  groups.forEach(function (group, gIdx) {
    var sb = project.storyboards[gIdx] || {};
    var imgSrc = sb.rawUrl || sb.imageUrl || "";
    var isActive = gIdx === _vpSelectedGroup;

    var totalDur = _plannedGroupDuration(group);
    var durStart = 0;
    for (var gi = 0; gi < gIdx; gi++) {
      var prevGroup = groups[gi];
      if (prevGroup) durStart += _plannedGroupDuration(prevGroup);
    }
    var durEnd = durStart + totalDur;

    var frame = document.createElement("div");
    frame.className = "group relative cursor-pointer transition-all duration-500" +
      (isActive ? "" : " opacity-50 hover:opacity-90");
    frame.dataset.vpFrame = gIdx;

    var imgHtml = imgSrc
      ? '<img class="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" loading="lazy" decoding="async" src="' + escapeHtml(imgSrc) + '" />'
      : '<div class="w-full h-full flex items-center justify-center bg-surface-container"><span class="material-symbols-outlined text-3xl text-on-surface-variant/15">movie_filter</span></div>';

    var shotLabel = group.shots.map(function (s) { return escapeHtml(s.shotType || ''); }).filter(Boolean).join(' · ');
    var shotNumberLabel = _vpShotNumberLabel(group, gIdx);

    // 每张卡片自带 @ / 重新生成 / 复制 三按钮，尺寸（w-6 h-6 + text-[13px] 图标）
    // 跟同行的状态 badge / 时间码 pill 视觉对齐。
    // 这三个按钮原本在右上角顶栏，是"操作当前选中片段"的语义；现在改成"操作这张卡所属片段"。
    // 用 data-action + data-gidx 标记，handler 在 frame 创建后直接绑，
    // ev.stopPropagation() 防止点按钮冒泡触发 frame 的选中逻辑。
    var btnBaseCls = 'shrink-0 w-6 h-6 rounded-full bg-surface-container-lowest hover:bg-surface-container transition-colors flex items-center justify-center';
    var iconCls = 'material-symbols-outlined text-[13px] text-outline';
    frame.innerHTML =
      '<div class="vp-frame-shot-number">' + escapeHtml(shotNumberLabel) + '</div>' +
      '<div class="aspect-[21/9] rounded-xl overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.05)] bg-surface-container-lowest transition-transform duration-500 group-hover:scale-[1.02]' +
        (isActive ? ' ring-2 ring-primary/30' : '') + '">' +
        imgHtml +
      '</div>' +
      '<div class="mt-3 flex justify-between items-center px-1">' +
        '<span class="text-xs font-bold text-on-surface">' + (shotLabel || '片段 ' + (gIdx + 1)) + '</span>' +
        '<div class="flex items-center gap-1.5">' +
          '<button type="button" data-action="vp-frame-ref" data-gidx="' + gIdx + '" class="' + btnBaseCls + '" title="引用到 AI 助手">' +
            '<span class="' + iconCls + '">alternate_email</span>' +
          '</button>' +
          '<button type="button" data-action="vp-frame-regen" data-gidx="' + gIdx + '" class="' + btnBaseCls + '" title="重新生成此片段提示词" data-write-action>' +
            '<span class="' + iconCls + '">refresh</span>' +
          '</button>' +
          '<button type="button" data-action="vp-frame-copy" data-gidx="' + gIdx + '" class="' + btnBaseCls + '" title="复制此片段提示词">' +
            '<span class="' + iconCls + '">content_copy</span>' +
          '</button>' +
          _videoPromptStatusBadge(sb) +
          '<span class="text-[10px] bg-surface-container-highest px-3 py-1 rounded-full text-on-tertiary-container font-bold">' +
            '0:' + String(durStart).padStart(2, '0') + ' - 0:' + String(durEnd).padStart(2, '0') +
          '</span>' +
        '</div>' +
      '</div>';

    var _refBtn = frame.querySelector('[data-action="vp-frame-ref"]');
    if (_refBtn) _refBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var sbR = project && project.storyboards && project.storyboards[gIdx];
      agentInsertRef('视频提示词', '片段' + (gIdx + 1), { groupIdx: gIdx, prompt: _vpCurrentText(sbR || {}) });
    });
    var _regenBtn = frame.querySelector('[data-action="vp-frame-regen"]');
    if (_regenBtn) _regenBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (_videoPromptsGenerating) { showToast('正在批量生成中，请稍候', 'warn'); return; }
      generateGroupVideoPrompt(gIdx).then(function () { checkVideoPromptsConfirm(); });
    });
    var _copyBtn = frame.querySelector('[data-action="vp-frame-copy"]');
    if (_copyBtn) _copyBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var sbC = project && project.storyboards && project.storyboards[gIdx];
      var text = _vpCurrentText(sbC || {});
      if (text) {
        navigator.clipboard.writeText(text).then(function () { showToast('提示词已复制', 'ok'); });
      } else {
        showToast('当前没有可复制的提示词', 'warn');
      }
    });

    frame.addEventListener("click", async function () {
      await _vpFlushAutoSave(_vpSelectedGroup);
      _vpSelectedGroup = gIdx;
      _renderVpStoryboardFrames();
      renderVideoPromptList({ force: true });
    });

    container.appendChild(frame);
  });
  hydrateProtectedImageElements(container);
}

export function renderVideoPromptList(opts) {
  _syncRefs();
  var list = $("videoPromptList");
  if (!list || !project || !project.shots) return;
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var gIdx = _vpSelectedGroup;
  if (gIdx >= groups.length) { _vpSelectedGroup = 0; gIdx = 0; }
  var group = groups[gIdx];
  if (!group) return;
  var sb = project.storyboards[gIdx] || {};
  project.storyboards[gIdx] = sb;

  var active = document.activeElement;
  if (!(opts && opts.force) && active && active.id === "vpPromptTextarea" && parseInt(active.dataset.gidx || "-1", 10) === gIdx) {
    updateVideoPromptChrome(gIdx);
    return;
  }

  var displayText = _vpCurrentText(sb);
  _vpEnsureCache(sb, function () {
    if (gIdx === _vpSelectedGroup) updateVideoPromptChrome(gIdx);
  });

  list.innerHTML = "";
  var card = document.createElement("div");
  card.className = "vp-card vp-card--shell flex flex-col h-full";
  card.dataset.groupIdx = gIdx;

  var chrome = document.createElement("div");
  chrome.id = "vpPromptChrome";
  card.appendChild(chrome);

  if (displayText || _vpHasDraft(sb) || !sb.videoPrompt) {
    var glassPanel = document.createElement("div");
    glassPanel.className = "bg-white/40 backdrop-blur-[40px] rounded-[24px] p-5 border-b-2 border-primary-fixed-dim/30 shadow-sm relative overflow-hidden flex-grow flex flex-col gap-3";
    glassPanel.innerHTML =
      '<div class="flex items-center justify-between gap-3 relative z-10">' +
        '<div class="flex items-center gap-2 min-w-0">' +
          '<span class="material-symbols-outlined text-base text-primary">edit_note</span>' +
          '<span class="text-xs font-bold text-on-background">' + (_vpCurrentSource(sb) === 'draft' ? '视频提示词草稿' : '视频提示词') + '</span>' +
        '</div>' +
        '<div class="flex items-center gap-2 shrink-0">' +
          '<button type="button" class="px-3 py-1.5 rounded-full bg-surface text-[10px] font-bold text-on-surface-variant hover:bg-surface-container-highest" data-action="copy-vp">复制</button>' +
          '<button type="button" class="px-3 py-1.5 rounded-full bg-surface text-[10px] font-bold text-on-surface-variant hover:bg-surface-container-highest" data-action="restore-vp-backup"' + (sb.videoPromptBackup && sb.videoPromptBackup.content ? '' : ' disabled') + '>恢复</button>' +
	          '<button type="button" class="px-3 py-1.5 rounded-full bg-primary text-on-primary text-[10px] font-bold hover:opacity-90" data-action="commit-vp-draft"' + (_vpHasUsableDraft(sb) ? '' : ' disabled') + '>确认使用</button>' +
        '</div>' +
      '</div>';
    var textarea = document.createElement("textarea");
    textarea.id = "vpPromptTextarea";
    textarea.dataset.gidx = String(gIdx);
    // 默认状态：背景与边框均为透明，textarea 直接融入外层 glassPanel 的玻璃质感面板。
    // 焦点状态（用户点击开始编辑时）：浮出白色底色和实边框，提示进入编辑模式。
    textarea.className = "relative z-10 w-full flex-grow min-h-[420px] resize-none bg-transparent border border-transparent rounded-2xl p-4 text-xs leading-relaxed text-on-background outline-none transition-colors duration-150 focus:bg-white/65 focus:border-outline-variant/40 focus:ring-2 focus:ring-primary/10";
    textarea.value = displayText;
    textarea.placeholder = "视频提示词会显示在这里，可直接编辑。";
    function syncTextareaDraftAfterInput() {
      var text = textarea.value;
      _vpEnsureLocalDraft(gIdx, text);
      if (project.storyboards[gIdx]) project.storyboards[gIdx]._vpCache = null;
      var commitBtn = card.querySelector('[data-action="commit-vp-draft"]');
      if (commitBtn) commitBtn.disabled = !String(text || '').trim();
      updateVideoPromptChrome(gIdx);
      checkVideoPromptsConfirm();
    }
    textarea.addEventListener("compositionstart", function () {
      textarea.dataset.composing = "1";
      clearTimeout(_vpAutoSaveTimer);
      clearTimeout(_vpParseTimers[gIdx]);
    });
    textarea.addEventListener("compositionend", function () {
      textarea.dataset.composing = "0";
      syncTextareaDraftAfterInput();
      if (textarea.dataset.flushAfterComposition === "1") {
        delete textarea.dataset.flushAfterComposition;
        _vpFlushAutoSave(gIdx).catch(function (e) { console.warn('[VideoPromptDraft] composition flush failed:', e); });
      } else {
        _vpScheduleAutoSave(gIdx);
        _vpScheduleParse(gIdx);
      }
    });
    textarea.addEventListener("input", function () {
      syncTextareaDraftAfterInput();
      if (textarea.dataset.composing === "1") return;
      _vpScheduleAutoSave(gIdx);
      _vpScheduleParse(gIdx);
    });
    textarea.addEventListener("blur", function () {
      if (textarea.dataset.composing === "1") {
        textarea.dataset.flushAfterComposition = "1";
        return;
      }
      _vpFlushAutoSave(gIdx).catch(function (e) { console.warn('[VideoPromptDraft] blur flush failed:', e); });
    });
    glassPanel.appendChild(textarea);
    card.appendChild(glassPanel);
  } else {
    var emptyAction = _videoPromptUiState(sb);
    card.innerHTML =
      '<div class="bg-white/40 backdrop-blur-[40px] rounded-[24px] p-12 border-b-2 border-outline-variant/20 shadow-sm relative overflow-hidden flex flex-col items-center justify-center flex-grow">' +
        '<span class="material-symbols-outlined text-6xl text-on-surface-variant/15 mb-4">psychology</span>' +
        '<span class="text-sm text-on-surface-variant/40 font-medium">' + escapeHtml(emptyAction.hint) + '</span>' +
      '</div>';
  }
  list.appendChild(card);
  updateVideoPromptChrome(gIdx);
}

export function updateVpCard(gIdx, status, promptText, errMsg) {
  // Phase 3-A：loading 态的占位 DOM 搬到 render_hooks.renderVpCard；
  // done / error 的 list 渲染依赖本模块内部状态（_vpSelectedGroup /
  // project.storyboards），继续由这里负责。
  if (status === "loading" && gIdx === _vpSelectedGroup) {
    renderVpCard(gIdx, "loading", { loadingText: errMsg });
  } else if (status === "done" || status === "error") {
    if (gIdx === _vpSelectedGroup) renderVideoPromptList();
    _renderVpStoryboardFrames();
  }
  _updateVideoPromptBulkButtonLabel();
}

function _vpDraftNoticeHtml(sb, gIdx) {
  var parts = [];
  if (_vpHasDraft(sb)) {
    var staleDraft = sb.videoPromptEditDraft &&
      sb.videoPromptEditDraft.sourceHash &&
      sb.videoPromptSourceHash &&
      sb.videoPromptEditDraft.sourceHash !== sb.videoPromptSourceHash;
    parts.push(
      '<div class="flex items-center gap-2 px-4 py-3 mb-3 rounded-xl ' +
      (staleDraft ? 'bg-warning/10 border border-warning/20 text-warning' : 'bg-primary/8 border border-primary/15 text-primary') +
      ' text-xs font-medium">' +
      '<span class="material-symbols-outlined text-sm shrink-0">' + (staleDraft ? 'sync_problem' : 'edit_note') + '</span>' +
      '<span class="flex-1 min-w-0">' + (staleDraft ? '上游信息已变化，当前草稿基于旧版本；确认使用后会按当前上下文保存。' : '当前显示的是草稿，生成视频或确认使用前会先保存并提交。') + '</span>' +
      '<span id="vpDraftStatus" class="text-[11px] text-on-surface-variant/70 font-medium"></span>' +
      '</div>'
    );
  }
  if (project && project._staleFlags && project._staleFlags["video_prompt_" + gIdx]) {
    parts.push(
      '<div class="flex items-center gap-2 px-4 py-3 mb-3 rounded-xl bg-warning/10 border border-warning/20 text-warning text-xs font-medium">' +
      '<span class="material-symbols-outlined text-sm shrink-0">update</span>' +
      '<span class="flex-1 min-w-0">上游信息已变化，当前正式视频提示词可能需要重新生成或重新确认。</span>' +
      '</div>'
    );
  }
  return parts.join('');
}

function _vpStatusBannerHtml(sb) {
  if (!sb || !sb.videoPrompt || (sb.videoPromptStatus !== "generating" && sb.videoPromptStatus !== "failed")) return '';
  var failed = sb.videoPromptStatus === "failed";
  return '' +
    '<div class="' + (failed
      ? "flex items-center gap-2 px-4 py-3 mb-3 rounded-xl bg-error/8 border border-error/15 text-error text-xs font-medium"
      : "flex items-center gap-2 px-4 py-3 mb-3 rounded-xl bg-primary/8 border border-primary/15 text-primary text-xs font-medium") + '">' +
    '<span class="material-symbols-outlined text-sm shrink-0">' + (failed ? "error" : "hourglass_top") + '</span>' +
    '<span class="flex-1 min-w-0">' +
    (failed ? '本轮视频提示词生成失败，旧提示词仅供查看，不能继续生成视频。' : '正在生成新视频提示词，旧提示词仅供查看。') +
    '</span>' +
    '</div>';
}

function _vpSensitiveBannerHtml(parsed, parsePending, gIdx) {
  if (parsePending) {
    return '<div class="flex items-center gap-2 px-4 py-3 mb-3 rounded-xl bg-surface-container-highest/60 border border-outline-variant/30 text-on-surface-variant text-xs font-medium">' +
      '<span class="material-symbols-outlined text-sm shrink-0">search</span><span>扫描中…</span></div>';
  }
  var sensitiveHits = (parsed && parsed.sensitiveHits) || [];
  if (!sensitiveHits.length) return '';
  var senWords = sensitiveHits.map(function (h) { return h.word; });
  return '' +
    '<div class="flex items-center gap-3 px-4 py-3 mb-3 rounded-xl bg-error/8 border border-error/15">' +
    '<span class="material-symbols-outlined text-error text-base shrink-0">shield</span>' +
    '<span class="flex-1 text-xs text-error font-medium">检测到 ' + sensitiveHits.length + ' 个可能触发审核的词汇：' +
    '<span class="font-bold">' + escapeHtml(senWords.join('、')) + '</span></span>' +
    '<button type="button" class="shrink-0 px-4 py-1.5 bg-error text-on-error rounded-full text-[10px] font-bold tracking-wide hover:opacity-90 transition-all active:scale-95" data-action="fix-sensitive" data-gidx="' + gIdx + '">一键替换</button>' +
    '</div>';
}

export function updateVideoPromptChrome(gIdx) {
  _syncRefs();
  if (!project || !project.storyboards || !project.storyboards[gIdx]) return;
  var sb = project.storyboards[gIdx];
  var text = _vpCurrentText(sb);
  var parsed = vpGetCache(sb);
  var parsePending = !!(text && !vpCacheValid(sb._vpCache, text));
  var tagsEl = $("vpPromptTags");
  if (tagsEl) {
    if (parsePending) {
      tagsEl.innerHTML = '<span class="text-[10px] text-on-surface-variant/50 italic">扫描中…</span>';
    } else {
      var tags = parsed.motionTags || [];
      tagsEl.innerHTML = tags.map(function (t) {
        return '<span class="bg-surface-container-highest px-4 py-1.5 rounded-full text-[10px] font-bold text-on-surface-variant">' + escapeHtml(t) + '</span>';
      }).join('');
      if (!tags.length) tagsEl.innerHTML = '<span class="text-[10px] text-on-surface-variant/40 italic">生成提示词后自动生成关键词标签</span>';
    }
  }
  var chrome = $("vpPromptChrome");
  if (chrome) {
    chrome.innerHTML = _vpDraftNoticeHtml(sb, gIdx) + _vpStatusBannerHtml(sb) + _vpSensitiveBannerHtml(parsed, parsePending, gIdx);
  }
  if (_vpHasDraft(sb)) {
    var statusEl = $("vpDraftStatus");
    if (statusEl && !statusEl.textContent) _vpSetDraftStatus(sb._vpDraftLastSavedContent === text ? '草稿已保存' : '');
  }
}

export function checkVideoPromptsConfirm() {
  _syncRefs();
  var area = $("videoPromptsConfirmTopArea");
  if (!project || !project.storyboards) {
    if (area) area.hidden = true;
    return;
  }
		  var groups = getStoryboardGroups();
  _updateVideoPromptBulkButtonLabel(groups);
  _updateVideoPromptConfirmButton(groups);
}

/* ================================================================
   Business helpers
   ================================================================ */
function getVisualStyle() {
  var sb = project && project.styleBible;
  if (!sb) return "live-action realistic (真人实拍)";
  var vs = (sb.visualStyle || "").toLowerCase();
  if (vs.indexOf("动漫") !== -1 || vs.indexOf("anime") !== -1 || vs.indexOf("卡通") !== -1 || vs.indexOf("cartoon") !== -1) return "anime/animation style (动漫风格)";
  if (vs.indexOf("3d") !== -1 || vs.indexOf("cg") !== -1) return "3D CG cinematic";
  if (vs.indexOf("水墨") !== -1 || vs.indexOf("ink") !== -1) return "Chinese ink painting style";
  return "live-action realistic cinematic (真人实拍电影感)";
}

function buildCharacterDescForPrompt() {
  if (!project || !project.assets || !project.assets.characters || !project.assets.characters.length) return "";
  var lines = ["【CHARACTER REFERENCE (from Asset Library — MUST match exactly)】"];
  project.assets.characters.forEach(function (c) {
    lines.push("- " + c.name + " (" + (c.role || "") + "): " + (c.appearance || "") + " | Clothing: " + (c.clothing || "") + " | Temperament: " + (c.temperament || ""));
  });
  return lines.join("\n");
}

/* Phase 4：allocateNarrationToGroups / getPreviousClipSummaries 已下沉到
   后端 services/narration_allocator.py。前端不再做旁白分配或正则抽取，
   只负责把 project.narrations + 所有 group 的 shots 原样传给后端，
   并从 /api/video-prompt/generate 的 done 事件里取 narrationsUsed 写回
   storyboard。 */

/* ================================================================
   Generation
   ================================================================ */
export async function generateGroupVideoPrompt(gIdx) {
  _syncRefs();
  if (!project) return;
  if (_videoPromptsGenerating) { showToast("正在批量生成中，请稍候", "warn"); return; }
  var groups = getStoryboardGroups();
  var group = groups[gIdx];
  if (!group) return;
  if (!project.storyboards) project.storyboards = [];
  if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
  var currentSb = project.storyboards[gIdx];
  if (currentSb.videoPromptStatus === "generating") {
    showToast("当前片段的视频提示词正在生成中，请稍候", "warn");
    return;
  }
	  var originId = project.id;
	  var promptRunId = "vp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
	  _setVideoPromptStatus(gIdx, "generating", { videoPromptRunId: promptRunId });
	  _invalidateVideoForGroup(gIdx, project.storyboards[gIdx]);

	  updateVpCard(gIdx, "loading", null, "AI 分析图片与剧本…");

  var sbData = project.storyboards[gIdx];
  var sbRawUrl = sbData && sbData.rawUrl;
  var existingVp = (sbData && sbData.videoPrompt) || "";
  var assetRefs = [];
  var droppedRefs = [];
  try {
    var refResp = await apiPost('/api/assets/match-references', {
      project: { assets: project.assets },
      group: group,
      storyboardImageUrl: sbRawUrl || null,
    });
    assetRefs = refResp.refs || [];
    droppedRefs = refResp.droppedReferences || [];
  } catch (e) {
    console.warn('[VideoPrompt] match-references failed, continuing without refs:', e);
  }
  // Phase 4：旁白分配交给后端。这里把所有 group 的 shots 打包传过去——
  // allocator 需要看到全部才能做 voiceover 池均摊和"已分配"去重。
  var allGroupsShots = groups.map(function (gg) { return (gg && gg.shots) || []; });
  var allGroupsShotIndices = groups.map(function (gg) { return (gg && gg.shotIndices) || []; });

  var imageUrls = [];
  assetRefs.forEach(function (r) { if (r.url) imageUrls.push(r.url); });

  console.log("[VideoPrompt] Group " + (gIdx + 1) + " shots=" + group.shots.length + " images=" + imageUrls.length);
  updateVpCard(gIdx, "loading", null, imageUrls.length ? "分析图片并生成中… (" + imageUrls.length + " 张图)" : "文本生成中…");

  try {
    var _vpChars = 0;
    var _vpStepState = { buf: "" };
    var _vpDiagBox = (window.__qdIsAdmin === true)
      ? ($("vpDiagnostic_" + gIdx) || $("vpDiagnostic"))
      : null;
    if (_vpDiagBox) _vpDiagBox.hidden = false;
    var _vpDiagCaptor = _vpDiagBox ? attachDiagnostic(_vpDiagBox) : null;
    var resp = await apiPostStream("/api/video-prompt/generate", {
      shots: group.shots,
      shotIndices: group.shotIndices,
      styleBible: project.styleBible,
      assets: project.assets,
      assetRefs: assetRefs,
      droppedReferences: droppedRefs,
      narrations: (project && project.narrations) || [],
      allGroupsShots: allGroupsShots,
      allGroupsShotIndices: allGroupsShotIndices,
      groupIdx: gIdx,
      totalGroups: groups.length,
	      projectId: originId,
	      videoPromptRunId: promptRunId,
	      storyboardImageUrl: sbRawUrl || null,
      imageUrls: imageUrls,
      creatorProfile: formatCreatorProfileForApi(),
    }, function (chunk) {
      consumeStreamStepTags(chunk, _vpStepState, function (hint) { updateVpCard(gIdx, "loading", null, hint); });
      _vpChars += chunk.length;
      var pct = Math.min(90, 10 + Math.floor(_vpChars / 25));
      updateVpCard(gIdx, "loading", null, "生成进度 " + pct + "%");
    }, _vpDiagCaptor ? _vpDiagCaptor.onEvent : null);

    var cleaned = (resp.videoPrompt || "").trim().replace(/^["']|["']$/g, "");
    if (!cleaned) {
      // 不能写空覆盖现有 prompt，也不能让 UI 静默回到"待生成"状态
      throw new Error('AI 返回为空，未生成提示词');
    }
    var narrationsUsed = Array.isArray(resp.narrationsUsed) ? resp.narrationsUsed : [];
    var isCurrent = _safeWriteBack(originId, function (proj) {
	      if (!proj.storyboards) proj.storyboards = [];
	      if (!proj.storyboards[gIdx]) proj.storyboards[gIdx] = {};
		      proj.storyboards[gIdx].videoPrompt = cleaned;
			      proj.storyboards[gIdx].videoPromptStatus = "ready";
			      proj.storyboards[gIdx].videoPromptRunId = (resp.videoPromptRunId || promptRunId);
			      if (resp.videoPromptSourceHash) proj.storyboards[gIdx].videoPromptSourceHash = resp.videoPromptSourceHash;
			      proj.storyboards[gIdx].videoPromptUpdatedAt = new Date().toISOString();
		      delete proj.storyboards[gIdx].videoPromptEditDraft;
		      delete proj.storyboards[gIdx].videoPromptFailedAt;
		      delete proj.storyboards[gIdx].videoPromptLastError;
		      proj.storyboards[gIdx]._vpCache = null;
	      _invalidateVideoForGroup(gIdx, proj.storyboards[gIdx]);
	      proj.storyboards[gIdx].narrationsUsed = narrationsUsed;
	      if (Array.isArray(resp.referenceManifest)) proj.storyboards[gIdx].videoReferenceManifest = resp.referenceManifest;
	      if (Array.isArray(resp.droppedReferences)) proj.storyboards[gIdx].videoReferenceDropped = resp.droppedReferences;
	      if (proj._staleFlags) delete proj._staleFlags["video_prompt_" + gIdx];
	    });
	    if (isCurrent) updateVpCard(gIdx, "done", cleaned);
	  } catch (e) {
		    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
		    var errorMeta = _videoPromptErrorMeta(e);
		    if (_isVideoPromptOwnershipMeta(errorMeta) || !_isStillOwnerOfShot(gIdx, promptRunId)) {
		      await _reloadVideoPromptProjectFromServer();
		      showToast("此镜头已被新的生成任务接管", "info");
		      return;
		    }
		    var userErrMsg = _singleVideoPromptFailureMessage(errMsg, errorMeta).slice(0, 120);
		    _setVideoPromptStatus(gIdx, "failed", { videoPromptRunId: promptRunId, errorMsg: userErrMsg });
		    _invalidateVideoForGroup(gIdx, project.storyboards[gIdx]);
		    try { saveProject(); } catch (_saveErr) {}
		    if (project && project.id === originId) updateVpCard(gIdx, "error", null, userErrMsg);
	    showToast("视频提示词 #" + (gIdx + 1) + " 生成失败: " + userErrMsg, "error");
	  }
	}

export async function generateAllVideoPrompts(opts) {
  // Phase 3-B-3：后端 batch_runner 编排，前端只负责 UI + subscribeBatch。
  // 已删除：plan-batch 前端回退、vpParallel/VP_FALLBACK、vpFailed 重试队列。
  // 失败用 git revert 回滚，不在前端保留 fallback。
  var runOpts = opts && opts.__videoPromptRunOptions ? opts : {};
  _syncRefs();
  if (_videoPromptsGenerating) return;
  if (!project || !project.id) { showToast("请先保存项目", "warn"); return; }
  _videoPromptsGenerating = true;
  var btn = $("btnGenAllVideoPrompts");
  var hint = $("videoPromptsHint");
  if (btn) btn.disabled = true;

  var originId = project.id;
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var regenerateAll = _areAllVideoPromptsReady(groups);
  _updateVideoPromptBulkButtonLabel(groups);

  var targets = [];
  var activeGeneratingCount = 0;
  for (var i = 0; i < groups.length; i++) {
    var sbTarget = project.storyboards[i] || {};
    if (sbTarget.videoPromptStatus === "generating") { activeGeneratingCount++; continue; }
    if (_shouldBatchTargetVideoPrompt(sbTarget, regenerateAll)) {
      targets.push({
        groupIdx: i,
        idx: i,
        shotIndices: groups[i].shotIndices || [],
        totalGroups: groups.length,
      });
    }
  }
  // hint 文案要和实际跑什么对得上：
  //   - regenerateAll：12/12 全 ready 用户点了重新生成，全部要重跑
  //   - targets.length === groups.length：0 个 ready，全部初次生成
  //   - 中间态：targets.length < groups.length，是在补缺，要说清楚补几条
  if (hint && targets.length) {
    if (regenerateAll) hint.textContent = "正在重新生成全部视频提示词…";
    else if (targets.length === groups.length) hint.textContent = "正在批量生成视频提示词…";
    else hint.textContent = "正在补全 " + targets.length + " 条视频提示词…";
  }
  if (!targets.length) {
    if (activeGeneratingCount) {
      if (hint) hint.textContent = "还有 " + activeGeneratingCount + " 条提示词正在生成";
      showToast("还有 " + activeGeneratingCount + " 条提示词正在生成，请稍后", "warn");
    } else {
      if (hint) hint.textContent = groups.length + "/" + groups.length + " 条已生成";
      showToast("所有镜头都已有提示词，可选择单个镜头重新生成", "ok");
    }
    _videoPromptsGenerating = false;
    if (btn) btn.disabled = false;
    _updateVideoPromptBulkButtonLabel(groups);
    return;
  }
	  var totalCount = targets.length;

  var seqToGroupIdx = {};
  targets.forEach(function (t, seq) { seqToGroupIdx[seq] = t.groupIdx; });

  var startResp;
  try {
    startResp = await apiPost('/api/batch/start', {
      batchType: 'video_prompts',
      projectId: originId,
      targets: targets,
      options: { creatorProfile: formatCreatorProfileForApi() },
    });
    showConsistencyAggregateWarning(startResp);
  } catch (e) {
    console.error('[generateAllVideoPrompts] /api/batch/start failed:', e);
    var preflightPayload = _getVideoPromptPreflightPayload(e);
    if (preflightPayload) {
      if (hint) hint.textContent = _videoPromptPreflightHint(preflightPayload);
      showToast("生成前检查未通过，请先确认角色信息", "warn");
      _videoPromptsGenerating = false;
      if (btn) btn.disabled = false;
      _updateVideoPromptBulkButtonLabel(groups);
      await _handleVideoPromptPreflightBlocked(preflightPayload, runOpts, hint, btn);
      return;
    }
    var errMsg0 = ((e && e.message) || e).toString();
    if (hint) hint.textContent = "启动失败：" + errMsg0;
	    showToast("批量生成启动失败：" + _diagnoseApiError(errMsg0), "error");
	    targets.forEach(function (t) {
	      if (regenerateAll) {
	        var rollbackSb = project.storyboards && project.storyboards[t.groupIdx];
	        updateVpCard(t.groupIdx, "done", rollbackSb && rollbackSb.videoPrompt);
	        return;
	      }
	      _setVideoPromptStatus(t.groupIdx, "failed", { errorMsg: "启动失败" });
	      updateVpCard(t.groupIdx, "error", null, "启动失败");
    });
    _videoPromptsGenerating = false;
    if (btn) btn.disabled = false;
    _updateVideoPromptBulkButtonLabel(groups);
    return;
  }

	  targets.forEach(function (t) {
	    _setVideoPromptStatus(t.groupIdx, "generating", { videoPromptRunId: startResp.batchId });
	    _invalidateVideoForGroup(t.groupIdx, project.storyboards[t.groupIdx]);
	    updateVpCard(t.groupIdx, "loading", null, "AI 分析图片与剧本…");
	  });

  var doneCount = 0;
  var failCount = 0;
  var finished = false;
  // 去重保护：SSE + polling 同时跑，避免一个 group 处理两次
  var _seenDone = Object.create(null);
  var _seenFailed = Object.create(null);
  var firstFailureMsg = "";
  var failureStats = { character: 0, ownership: 0, writeback: 0, empty: 0, project: 0, model: 0 };

	  function _classifyVideoPromptFailure(errMsg, meta) {
	    return _classifyVideoPromptFailureKind(errMsg, meta);
	  }

  function _videoPromptFailureToast() {
    if (failureStats.character > 0) return "角色一致性检查未通过，请先确认角色信息";
    if (failureStats.ownership > 0) return failureStats.ownership + " 条提示词已被新的生成请求接管，页面会保留最新任务结果";
    if (failureStats.writeback > 0) return failureStats.writeback + " 条提示词生成后写回失败，请刷新项目状态后重试";
    if (failureStats.empty > 0) return failureStats.empty + " 条提示词返回为空，请单条重新生成";
    if (failureStats.project > 0) return "项目已不存在或无法访问，请刷新项目列表";
    return failCount + " 条提示词生成失败，请在缺失镜头里单条重试";
  }

  // 当 SSE 报"任务完成"但 extra.videoPrompt 是空字符串时（旧版 silent-drop bug），
  // 强制从服务器重读 project，把后端 executor 已经写入 DB 的 videoPrompt 拉回来。
  // 旧逻辑下 cleaned='' → _applyTaskCompleted 早 return → 既不算成功也不算失败 →
  // 用户看到 "0/5 条已生成" + 无任何 toast，体感"提示生成完了但啥也没有"。
  async function _rescueFromServerForGroup(gIdx) {
    if (!_ctx.reloadProjectFromServer) return '';
    try {
      await _ctx.reloadProjectFromServer();
	      _syncRefs();
	      var sb = project && project.storyboards && project.storyboards[gIdx];
	      return _isVideoPromptReady(sb) ? (sb.videoPrompt || '') : '';
    } catch (e) {
      console.warn('[VideoPrompt] _rescueFromServerForGroup failed:', e);
      return '';
    }
  }

  async function finish() {
    if (finished) return;
    finished = true;
    // 在最终统计前，再做一次权威同步——后端 executor 是先写 DB 再返回 extra，
    // 所以即使所有 SSE 事件都丢了，DB 里也应该是最新的；这一步把 UI 拉回真相。
    try {
      if (_ctx.reloadProjectFromServer) {
        await _ctx.reloadProjectFromServer();
        _syncRefs();
      }
    } catch (_e) {}
    _videoPromptsGenerating = false;
    if (btn) btn.disabled = false;
    var done = 0;
    for (var j = 0; j < groups.length; j++) {
	      if (_isVideoPromptReady(project.storyboards[j])) done++;
    }
    var missingLabels = _missingVideoPromptLabels(groups);
    if (hint) {
      hint.textContent = missingLabels.length
        ? done + "/" + groups.length + " 条已生成，缺少镜头 " + missingLabels.join("、")
        : done + "/" + groups.length + " 条已生成";
    }
    // 可能 reload 之后 done > 0 而 doneCount 还是 0（SSE 全丢的情况）——把卡片状态也刷一遍
    for (var jj = 0; jj < groups.length; jj++) {
	      var sbJ = project.storyboards[jj];
	      if (_isVideoPromptReady(sbJ)) updateVpCard(jj, "done", sbJ.videoPrompt);
	    }
	    var allDone = groups.length > 0 && groups.every(function (_, k) {
	      return _isVideoPromptReady(project.storyboards[k]);
	    });
    _updateVideoPromptBulkButtonLabel(groups);
    if (allDone) {
      showToast(regenerateAll ? "全部视频提示词已重新生成" : "全部视频提示词已生成", "success");
    } else if (done === 0 && failCount === 0) {
      // 既没成功也没失败 = 后端任务都"completed"了但内容空 / SSE 全丢且 DB 也没写 → 一定是后端故障
      showToast("批量已结束，但没有收到任务明细；请刷新项目状态后重试", "error");
    } else if (failCount > 0) {
      showToast(_videoPromptFailureToast(), failureStats.writeback > 0 ? "error" : "warn");
    } else if (done < groups.length) {
      showToast("已完成 " + done + "/" + groups.length + " 条，缺少镜头 " + missingLabels.join("、") + "，可单条补齐", "warn");
    }
    checkVideoPromptsConfirm();
    setTimeout(function () { _checkAndSuggest("videoPrompts"); }, 1000);
  }

	  function _applyTaskCompleted(gIdx, cleaned, narrationsUsed, extraData) {
	    if (typeof gIdx !== 'number') return;
	    if (_seenDone[gIdx]) return;
	    var incomingRunId = extraData && extraData.videoPromptRunId;
	    var currentSb = project && project.storyboards && project.storyboards[gIdx];
	    if (incomingRunId && currentSb && currentSb.videoPromptRunId && currentSb.videoPromptRunId !== incomingRunId) {
	      console.warn('[VideoPrompt] ignored stale completion for group ' + gIdx + ' run=' + incomingRunId + ' current=' + currentSb.videoPromptRunId);
	      _reloadVideoPromptProjectFromServer();
	      return;
	    }
	    if (!cleaned) {
      // SSE/polling 报告任务完成但 extra/patch 都空——后端 executor 已经写过 DB，
      // 拉回来兜底；如果 DB 里也没有，标记为失败让用户能看到"重新生成"按钮。
      _rescueFromServerForGroup(gIdx).then(function (vp) {
        if (vp) {
	          _applyTaskCompleted(gIdx, vp, narrationsUsed, extraData);
        } else if (!_seenFailed[gIdx] && !_seenDone[gIdx]) {
          _applyTaskFailed(gIdx, '后端任务返回为空', { errorCode: 'VIDEO_PROMPT_EMPTY_RESULT' });
        }
      });
      return;
    }
    _seenDone[gIdx] = true;
    doneCount++;
    var referenceManifest = null;
    var droppedReferences = null;
    if (extraData) {
      if (Array.isArray(extraData.referenceManifest)) referenceManifest = extraData.referenceManifest;
      else if (Array.isArray(extraData.videoReferenceManifest)) referenceManifest = extraData.videoReferenceManifest;
      if (Array.isArray(extraData.droppedReferences)) droppedReferences = extraData.droppedReferences;
      else if (Array.isArray(extraData.videoReferenceDropped)) droppedReferences = extraData.videoReferenceDropped;
    }

    var isCurrent = _safeWriteBack(originId, function (proj) {
	      if (!proj.storyboards) proj.storyboards = [];
	      if (!proj.storyboards[gIdx]) proj.storyboards[gIdx] = {};
		      proj.storyboards[gIdx].videoPrompt = cleaned;
		      proj.storyboards[gIdx].videoPromptStatus = "ready";
			      if (incomingRunId) proj.storyboards[gIdx].videoPromptRunId = incomingRunId;
			      if (extraData && extraData.videoPromptSourceHash) proj.storyboards[gIdx].videoPromptSourceHash = extraData.videoPromptSourceHash;
			      proj.storyboards[gIdx].videoPromptUpdatedAt = new Date().toISOString();
		      delete proj.storyboards[gIdx].videoPromptEditDraft;
		      delete proj.storyboards[gIdx].videoPromptFailedAt;
		      delete proj.storyboards[gIdx].videoPromptLastError;
		      proj.storyboards[gIdx]._vpCache = null;
	      _invalidateVideoForGroup(gIdx, proj.storyboards[gIdx]);
      if (Array.isArray(narrationsUsed)) proj.storyboards[gIdx].narrationsUsed = narrationsUsed;
      if (referenceManifest !== null) proj.storyboards[gIdx].videoReferenceManifest = referenceManifest;
      if (droppedReferences !== null) proj.storyboards[gIdx].videoReferenceDropped = droppedReferences;
      if (proj._staleFlags) delete proj._staleFlags["video_prompt_" + gIdx];
    });
    if (isCurrent) updateVpCard(gIdx, "done", cleaned);
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
  }

  function _applyTaskFailed(gIdx, errMsg, meta) {
    if (typeof gIdx !== 'number') return;
    if (_seenFailed[gIdx] || _seenDone[gIdx]) return;
    meta = meta || {};
    var incomingRunId = meta.incomingRunId || meta.videoPromptRunId;
    if (_isVideoPromptOwnershipMeta(meta) || (incomingRunId && !_isStillOwnerOfShot(gIdx, incomingRunId))) {
      console.warn('[VideoPrompt] ignored stale failure for group ' + gIdx + ' run=' + (incomingRunId || '?') + ' reason=' + (meta.skippedReason || meta.errorCode || 'ownership'));
      _reloadVideoPromptProjectFromServer();
      return;
    }
	    _seenFailed[gIdx] = true;
	    failCount++;
	    if (!firstFailureMsg && errMsg) firstFailureMsg = String(errMsg);
	    var failureKind = _classifyVideoPromptFailure(errMsg, meta);
	    failureStats[failureKind] = (failureStats[failureKind] || 0) + 1;
	    if (!project.storyboards) project.storyboards = [];
	    if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
	    _setVideoPromptStatus(gIdx, "failed", { videoPromptRunId: incomingRunId, errorMsg: (errMsg || '生成失败').toString().slice(0, 120) });
	    _invalidateVideoForGroup(gIdx, project.storyboards[gIdx]);
	    updateVpCard(gIdx, "error", null, (errMsg || '生成失败').toString().slice(0, 120));
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
  }

  function _applySnapshotTask(t) {
    if (!t || !t.status) return;
    if (t.status === 'completed') {
      var result = t.result || {};
      var extra = result.extra || {};
      var patch = result.patch || {};
      if (!extra.videoPromptRunId) extra.videoPromptRunId = result.videoPromptRunId || startResp.batchId;
      var gIdx = (typeof extra.groupIdx === 'number')
        ? extra.groupIdx
        : ((t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq]);
      var cleaned = (extra.videoPrompt || patch.value || '').toString().trim().replace(/^["']|["']$/g, "");
      var narrationsUsed = Array.isArray(extra.narrationsUsed) ? extra.narrationsUsed : [];
      if (!Array.isArray(extra.referenceManifest) && Array.isArray(patch.videoReferenceManifest)) {
        extra.referenceManifest = patch.videoReferenceManifest;
      }
      if (!Array.isArray(extra.droppedReferences) && Array.isArray(patch.videoReferenceDropped)) {
        extra.droppedReferences = patch.videoReferenceDropped;
      }
      _applyTaskCompleted(gIdx, cleaned, narrationsUsed, extra);
    } else if (t.status === 'failed') {
      var gIdx2 = (t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq];
      var failedResult = t.result || {};
      var failedExtra = failedResult.extra || {};
      _applyTaskFailed(gIdx2, t.errorMsg, {
        failureStage: failedResult.failureStage || failedExtra.failureStage,
        errorCode: failedResult.errorCode || failedExtra.errorCode,
        incomingRunId: failedExtra.videoPromptRunId || failedResult.videoPromptRunId || startResp.batchId,
        videoPromptRunId: failedExtra.videoPromptRunId || failedResult.videoPromptRunId || startResp.batchId,
        skippedReason: failedResult.skippedReason || failedExtra.skippedReason,
        failureApplied: Object.prototype.hasOwnProperty.call(failedResult, 'failureApplied')
          ? failedResult.failureApplied
          : failedExtra.failureApplied,
        storedRunId: failedResult.storedRunId || failedExtra.storedRunId,
        storedStatus: failedResult.storedStatus || failedExtra.storedStatus,
      });
    }
  }

  // ============================================================
  // 兜底轮询：每 5 秒主动 GET /api/batch/<id>。SSE 不稳定时由它兜底。
  // ============================================================
  var pollTimer = null;
  function _stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function _pollOnce() {
    if (finished) return;
    try {
      var snap = await apiGet("/api/batch/" + encodeURIComponent(startResp.batchId));
      if (!snap || finished) return;
      var tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
      tasks.forEach(_applySnapshotTask);
      if (snap.status === 'completed' || snap.status === 'failed' ||
          snap.status === 'cancelled' || snap.status === 'partial') {
        console.log('[VideoPrompt] poll detected batch finished status=' + snap.status);
        _stopPoll();
        finish();
      }
    } catch (e) {
      console.warn('[VideoPrompt] poll failed:', (e && e.message) || e);
    }
  }
  pollTimer = setInterval(_pollOnce, 5000);

  subscribeBatch(startResp.batchId, {
    onSnapshot: function (snap) {
      if (hint && snap && typeof snap.total === 'number') {
        hint.textContent = "生成中… " + (snap.succeeded || 0) + "/" + snap.total;
      }
      if (snap && Array.isArray(snap.tasks)) snap.tasks.forEach(_applySnapshotTask);
    },
    onTaskStarted: function (data) {
      var extra = data.target || {};
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      if (typeof gIdx === 'number' && !_seenDone[gIdx]) {
        updateVpCard(gIdx, "loading", null, "生成中…");
      }
    },
    onTaskCompleted: function (data) {
      var extra = data.extra || {};
      var patch = data.patch || {};
      if (!extra.videoPromptRunId) extra.videoPromptRunId = data.videoPromptRunId || startResp.batchId;
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      var cleaned = (extra.videoPrompt || patch.value || '').toString().trim().replace(/^["']|["']$/g, "");
      var narrationsUsed = Array.isArray(extra.narrationsUsed) ? extra.narrationsUsed : [];
	      _applyTaskCompleted(gIdx, cleaned, narrationsUsed, extra);
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      _applyTaskFailed(gIdx, data.errorMsg, {
        failureStage: data.failureStage || extra.failureStage,
        errorCode: data.errorCode || extra.errorCode,
        incomingRunId: extra.videoPromptRunId || data.videoPromptRunId || startResp.batchId,
        videoPromptRunId: extra.videoPromptRunId || data.videoPromptRunId || startResp.batchId,
        skippedReason: data.skippedReason || extra.skippedReason,
        failureApplied: Object.prototype.hasOwnProperty.call(data, 'failureApplied')
          ? data.failureApplied
          : extra.failureApplied,
        storedRunId: data.storedRunId || extra.storedRunId,
        storedStatus: data.storedStatus || extra.storedStatus,
      });
    },
    onBatchCompleted: function () {
      _stopPoll();
      finish();
    },
    onClose: function () {
      // SSE 断开不立即 finish，让 polling 接管
    },
  });
}

export async function confirmVideoPrompts() {
  _syncRefs();
		  if (!project || !project.storyboards) return;
  var committed = await _vpCommitAllDrafts();
  if (!committed) return;
  _syncRefs();
		  var groups = getStoryboardGroups();
	  var missing = groups.filter(function (_, i) { return !_isVideoPromptReady(project.storyboards[i]); });
	  if (missing.length) { showToast("还有 " + missing.length + " 条视频提示词未就绪", "warn"); return; }
  project.videoPromptsApproved = true;
  project.currentStep = Math.max(project.currentStep, 6);
  if (_ctx.flushServerSave) {
    await _ctx.flushServerSave();
  } else {
    saveProject();
  }
  switchPage("batch");
}

function _formatRefineViolations(resp) {
  var violations = Array.isArray(resp && resp.violations) ? resp.violations : [];
  if (!violations.length) return "AI 微调结果破坏了原提示词的不可变事实，已保留原提示词。";
  return violations.slice(0, 4).map(function (v) {
    return (v && (v.message || v.type)) ? String(v.message || v.type) : "不可变事实被改动";
  }).join("\n");
}

async function _handleRefineRejected(gIdx, resp, previousPrompt) {
  if (project && project.storyboards && project.storyboards[gIdx]) {
    project.storyboards[gIdx].lastRefineViolations = Array.isArray(resp && resp.violations) ? resp.violations : [];
  }
  renderVideoPromptList({ force: true });
  _renderVpStoryboardFrames();
  checkVideoPromptsConfirm();
  await showConfirm(
    "微调未通过一致性检查",
    _formatRefineViolations(resp),
    "保留原提示词",
    "关闭"
  );
}

export async function refineVideoPrompt(instruction) {
  _syncRefs();
  var gIdx = _vpSelectedGroup;
  var currentPrompt = project && project.storyboards && project.storyboards[gIdx] ? _vpCurrentText(project.storyboards[gIdx]) : "";
  if (!project || !project.storyboards || !project.storyboards[gIdx] || !currentPrompt) {
    showToast("当前片段还没有提示词，请先生成", "warn"); return;
  }
  var originId = project.id;
  var input = $("vpRefineInput");
  var btn = $("vpBtnRefine");
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;

  try {
    var resp = await apiPostStream("/api/video-prompt/refine", {
      currentPrompt: currentPrompt,
      instruction: instruction,
      projectId: originId,
      groupIdx: gIdx,
      referenceManifest: (project.storyboards[gIdx] && project.storyboards[gIdx].videoReferenceManifest) || [],
    }, function () {});
    if (resp.accepted === false) {
      await _handleRefineRejected(gIdx, resp, resp.previousPrompt || currentPrompt);
    } else {
      var refined = (resp.videoPrompt || "").trim().replace(/^["'`]|["'`]$/g, "");
      if (!refined) { showToast("AI 返回为空，修改失败", "error"); return; }
      if (project && project.id === originId) {
        _vpEnsureLocalDraft(gIdx, refined);
        if (project.storyboards[gIdx]) project.storyboards[gIdx]._vpCache = null;
        await _vpSaveDraftNow(gIdx, refined, { force: true });
        var ta = $("vpPromptTextarea");
        if (ta && parseInt(ta.dataset.gidx || "-1", 10) === gIdx) ta.value = refined;
        _vpScheduleParse(gIdx);
        updateVideoPromptChrome(gIdx);
        _renderVpStoryboardFrames();
        checkVideoPromptsConfirm();
        showToast("提示词草稿已更新", "ok");
      }
    }
  } catch (e) {
    showToast("修改失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
  }
  if (btn) btn.disabled = false;
  if (input) { input.disabled = false; input.value = ""; }
}

export async function handleVideoPromptAction(e) {
  _syncRefs();
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var card = btn.closest(".vp-card");
  if (!card) return;
  var gIdx = parseInt(card.dataset.groupIdx, 10);
  var action = btn.dataset.action;

  if (action === "regen-vp") {
    if (_videoPromptsGenerating) { showToast("正在批量生成中，请稍候", "warn"); return; }
    generateGroupVideoPrompt(gIdx).then(function () { checkVideoPromptsConfirm(); });
  } else if (action === "copy-vp") {
    var copyText = _vpCurrentText(project.storyboards[gIdx] || {});
    if (copyText) navigator.clipboard.writeText(copyText).then(function () { showToast('提示词已复制', 'ok'); });
    else showToast('当前没有可复制的提示词', 'warn');
  } else if (action === "commit-vp-draft") {
    var okCommit = await _vpCommitDraft(gIdx);
    if (okCommit) {
      renderVideoPromptList({ force: true });
      _renderVpStoryboardFrames();
      checkVideoPromptsConfirm();
      showToast('视频提示词已确认使用', 'ok');
    }
  } else if (action === "restore-vp-backup") {
    var okRestore = await showConfirm('恢复视频提示词', '将用备份提示词替换当前正式提示词，并清空当前草稿。', '恢复', '取消');
    if (!okRestore) return;
    try {
      await _vpFlushAutoSave(gIdx);
      var resp = await apiPost('/api/video-prompt/restore-backup', {
        projectId: project.id,
        groupIdx: gIdx,
      });
      if (project.storyboards && project.storyboards[gIdx]) {
        project.storyboards[gIdx].videoPrompt = resp.videoPrompt || '';
        project.storyboards[gIdx].videoPromptSourceHash = resp.videoPromptSourceHash || null;
        project.storyboards[gIdx].videoPromptRunId = resp.videoPromptRunId || project.storyboards[gIdx].videoPromptRunId;
        project.storyboards[gIdx].videoPromptStatus = 'ready';
        project.storyboards[gIdx].videoPromptUpdatedAt = new Date().toISOString();
        delete project.storyboards[gIdx].videoPromptEditDraft;
        delete project.storyboards[gIdx].videoPromptFailedAt;
        delete project.storyboards[gIdx].videoPromptLastError;
        project.storyboards[gIdx]._vpCache = null;
        _invalidateVideoForGroup(gIdx, project.storyboards[gIdx]);
        _clearStale("video_prompt_" + gIdx);
      }
      renderVideoPromptList({ force: true });
      _renderVpStoryboardFrames();
      checkVideoPromptsConfirm();
      showToast('已恢复备份提示词', 'ok');
    } catch (err) {
      showToast('恢复失败：' + _diagnoseApiError(((err && err.message) || err).toString()), 'error');
    }
  } else if (action === "edit-vp") {
    var ta = $("vpPromptTextarea");
    if (ta) ta.focus();
  } else if (action === "fix-sensitive") {
    _aiFixSensitiveWords(gIdx);
  } else if (action === "delete-vp") {
	    showConfirm("删除视频提示词", "确定删除片段 " + (gIdx + 1) + " 的视频提示词？", function () {
	      if (project.storyboards[gIdx]) {
	        project.storyboards[gIdx].videoPrompt = "";
	        project.storyboards[gIdx].videoPromptStatus = "failed";
	        project.storyboards[gIdx].videoPromptFailedAt = new Date().toISOString();
	        project.storyboards[gIdx].videoPromptLastError = "用户删除了视频提示词";
	        _invalidateVideoForGroup(gIdx, project.storyboards[gIdx]);
	      }
      saveProject();
      renderVideoPromptList();
      _renderVpStoryboardFrames();
      checkVideoPromptsConfirm();
    });
  }
}

async function _aiFixSensitiveWords(gIdx) {
  _syncRefs();
  var currentPrompt = project && project.storyboards && project.storyboards[gIdx] ? _vpCurrentText(project.storyboards[gIdx]) : "";
  if (!project || !project.storyboards || !project.storyboards[gIdx] || !currentPrompt) {
    showToast("当前片段还没有提示词", "warn"); return;
  }
  var hits = [];
  try {
    var scan = await apiPost('/api/prompt/scan-sensitive', { text: currentPrompt });
    hits = scan.hits || [];
  } catch (e) { console.warn('[ScanSensitive] failed:', e); hits = []; }
  if (!hits.length) { showToast("未检测到敏感词", "ok"); return; }

  var wordList = hits.map(function (h) { return h.word; });
  var instruction =
    "请仅替换以下可能触发视频生成API内容审核的敏感词汇，" +
    "替换为含义相近但更温和的视觉描述表达（保留画面动作含义）。" +
    "严禁修改其他任何内容，时间轴、运镜、角色、参考图编号等保持100%不变。" +
    "需要替换的词：" + wordList.join("、");

  showToast("正在 AI 替换敏感词…", "ok");
  var originId = project.id;

  try {
    var resp = await apiPostStream("/api/video-prompt/refine", {
      currentPrompt: currentPrompt,
      instruction: instruction,
      projectId: originId,
      groupIdx: gIdx,
      referenceManifest: (project.storyboards[gIdx] && project.storyboards[gIdx].videoReferenceManifest) || [],
      guardMode: "off",
    }, function () {});
    if (resp.accepted === false) {
      await _handleRefineRejected(gIdx, resp, resp.previousPrompt || currentPrompt);
      return;
    }
    var refined = (resp.videoPrompt || "").trim().replace(/^["'`]|["'`]$/g, "");
    if (!refined) { showToast("AI 返回为空，替换失败", "error"); return; }
    if (project && project.id === originId) {
      _vpEnsureLocalDraft(gIdx, refined);
      if (project.storyboards[gIdx]) project.storyboards[gIdx]._vpCache = null;
      await _vpSaveDraftNow(gIdx, refined, { force: true });
      var ta = $("vpPromptTextarea");
      if (ta && parseInt(ta.dataset.gidx || "-1", 10) === gIdx) ta.value = refined;
      _vpScheduleParse(gIdx);
      updateVideoPromptChrome(gIdx);
      _renderVpStoryboardFrames();
      checkVideoPromptsConfirm();
      var remainingHits = [];
      try {
        var rescan = await apiPost('/api/prompt/scan-sensitive', { text: refined });
        remainingHits = rescan.hits || [];
      } catch (e) { remainingHits = []; }
      if (remainingHits.length) {
        showToast("已替换部分敏感词，仍有 " + remainingHits.length + " 个待处理", "warn");
      } else {
        showToast("敏感词已全部替换", "ok");
      }
    }
  } catch (e) {
    showToast("敏感词替换失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
  }
}
