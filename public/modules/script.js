import { $, escapeHtml, showToast, apiPost, apiPostStream, consumeStreamStepTags, stripStepTags, getAuthHeaders, friendlyGatewayTransientError } from './utils.js?v=203';
import { emptyScriptConsultState, isEmptyScriptConsultState } from './script_consult_state.js';

var _ctx = {};
var project = null;

export function initScript(ctx) { _ctx = ctx; }
export function syncScriptProject(p) {
  var prevId = project && project.id;
  var nextId = p && p.id;
  if (_scriptConsultGuardEnabled() && prevId !== nextId) {
    _abortActiveScriptRequest("project_changed");
    _clearScriptTransientInput();
    _pendingSourceChoice = false;
    _scriptProjectEpoch++;
  }
  project = p;
}

var _scriptGenerating = false;
var _emotionTagInflight = {};
var _emotionAutoTried = {};
var _pendingSourceChoice = false;
var _scriptRequestSeq = 0;
var _scriptProjectEpoch = 0;
var _activeScriptRequest = null;

export function isScriptGenerating() {
  return _scriptGenerating;
}

function _scriptErrorText(err, limit) {
  var raw = ((err && err.message) || err || "").toString();
  var friendly = friendlyGatewayTransientError(raw);
  return (friendly || raw || "生成失败，请稍后重试").slice(0, limit || 150);
}

var EMOTION_LABEL_CN = {
  setup: "铺垫", rising: "升温", climax: "高潮",
  falling: "回落", resolution: "余韵", transition: "过渡"
};
var PACING_LABEL_CN = {
  slow: "慢节奏", steady: "中节奏", fast: "快切", burst: "爆发"
};

export function emotionBadgeHtml(emotion, intensity) {
  var lv = Math.max(1, Math.min(5, intensity || 3));
  var label = EMOTION_LABEL_CN[emotion] || emotion || "?";
  return '<span class="emotion-badge emotion-badge--' + lv + '">' + escapeHtml(label) + ' ' + lv + '</span>';
}

export function chatClearWelcome() {
  var w = $("chatWelcome");
  if (w) w.hidden = true;
}

export function chatAddMsg(type, html) {
  chatClearWelcome();
  var box = $("chatMessages");
  if (!box) return null;
  var innerWrap = box.querySelector(".max-w-2xl") || box;
  var msg = document.createElement("div");
  msg.className = "chat-msg chat-msg--" + type;
  if (type === "user") {
    msg.innerHTML = '<div class="chat-bubble chat-bubble--user">' + html + '</div>';
  } else if (type === "ai") {
    msg.innerHTML = '<div class="chat-avatar w-8 h-8 rounded-full bg-secondary-container/30 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary text-sm" style="font-variation-settings:\'FILL\' 1">auto_awesome</span></div><div class="chat-bubble chat-bubble--ai"></div>';
  } else {
    msg.innerHTML = '<div class="chat-avatar w-8 h-8 rounded-full bg-secondary-container/30 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary text-sm" style="font-variation-settings:\'FILL\' 1">auto_awesome</span></div><div class="chat-bubble chat-bubble--status">' + html + '</div>';
  }
  innerWrap.appendChild(msg);
  _scrollChatToBottom();
  return msg;
}

export function chatShowDots() {
  chatClearWelcome();
  var box = $("chatMessages");
  if (!box) return null;
  var innerWrap = box.querySelector(".max-w-2xl") || box;
  var existing = box.querySelector("#chatTyping");
  if (existing) existing.parentNode.removeChild(existing);
  var msg = document.createElement("div");
  msg.className = "chat-msg chat-msg--ai";
  msg.id = "chatTyping";
  msg.innerHTML = '<div class="chat-avatar w-8 h-8 rounded-full bg-secondary-container/30 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary text-sm" style="font-variation-settings:\'FILL\' 1">auto_awesome</span></div><div class="chat-bubble chat-bubble--ai"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
  innerWrap.appendChild(msg);
  _scrollChatToBottom();
  return msg;
}

export function chatRemoveDots() {
  var el = document.getElementById("chatTyping");
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

export function typewriter(element, text, chunkSize, delayMs) {
  return new Promise(function (resolve) {
    var i = 0;
    chunkSize = chunkSize || 2;
    delayMs = delayMs || 18;
    element.textContent = "";
    function step() {
      if (i < text.length) {
        element.textContent += text.slice(i, i + chunkSize);
        i += chunkSize;
        _scrollChatToBottom();
        setTimeout(step, delayMs);
      } else {
        resolve();
      }
    }
    step();
  });
}

export function chatAutoResize(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  var nextHeight = Math.max(38, Math.min(textarea.scrollHeight || 38, 110));
  textarea.style.height = nextHeight + "px";
}

function _scrollChatToBottom() {
  var box = $("chatMessages");
  if (box) { setTimeout(function() { box.scrollTop = box.scrollHeight; }, 60); }
}

function _scriptMessageContainer() {
  var box = $("chatMessages");
  return box ? (box.querySelector(".max-w-2xl") || box) : null;
}

function _clearScriptTransientInput() {
  var input = $("ideaInput");
  if (input) {
    input.value = "";
    chatAutoResize(input);
  }
}

function _scriptConsultGuardEnabled() {
  return !_ctx.isFeatureEnabled || _ctx.isFeatureEnabled("scriptConsultGuard", true);
}

function _newScriptRequestGuard(originId, label) {
  var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  var guard = {
    id: ++_scriptRequestSeq,
    label: label || "script",
    originId: originId || "",
    projectEpoch: _scriptProjectEpoch,
    controller: controller,
  };
  _activeScriptRequest = guard;
  return guard;
}

function _isScriptRequestCurrent(guard) {
  if (!_scriptConsultGuardEnabled()) return true;
  return !!(
    guard &&
    _activeScriptRequest === guard &&
    guard.projectEpoch === _scriptProjectEpoch &&
    project &&
    project.id === guard.originId &&
    !(guard.controller && guard.controller.signal && guard.controller.signal.aborted)
  );
}

function _finishScriptRequest(guard) {
  if (_activeScriptRequest === guard) _activeScriptRequest = null;
}

function _abortActiveScriptRequest(reason) {
  if (!_scriptConsultGuardEnabled()) return;
  if (_activeScriptRequest && _activeScriptRequest.controller) {
    try { _activeScriptRequest.controller.abort(reason || "aborted"); } catch (_) {}
  }
  _activeScriptRequest = null;
  _scriptGenerating = false;
  var btn = $("btnGenScript");
  if (btn) btn.disabled = false;
  chatRemoveDots();
}

function _clearConsultDomForEmptyProject() {
  var box = $("chatMessages");
  if (!box) return;
  var innerWrap = box.querySelector(".max-w-2xl") || box;
  var msgs = innerWrap.querySelectorAll(".chat-msg:not(#scriptResultCard)");
  msgs.forEach(function (m) { if (m.parentNode) m.parentNode.removeChild(m); });
  delete box.dataset.consultVersion;
  var resultCard = $("scriptResultCard");
  if (resultCard) resultCard.hidden = true;
  var displayText = $("scriptDisplayText");
  if (displayText) displayText.textContent = "";
  var editArea = $("scriptOutput");
  if (editArea) editArea.value = "";
  _hideScriptConfirmArea();
  _syncScriptWelcomeVisibility();
}

function _moveScriptResultToEnd() {
  var resultCard = $("scriptResultCard");
  var wrap = _scriptMessageContainer();
  if (resultCard && wrap && resultCard.parentNode === wrap) wrap.appendChild(resultCard);
}

function _showScriptConfirmArea() {
  var confirmArea = $("scriptConfirmArea");
  if (!confirmArea) return;
  var innerWrap = document.querySelector("#chatMessages .max-w-2xl");
  if (innerWrap) innerWrap.appendChild(confirmArea);
  confirmArea.hidden = false;
  _scrollChatToBottom();
}

function _hideScriptConfirmArea() {
  var confirmArea = $("scriptConfirmArea");
  if (confirmArea) confirmArea.hidden = true;
}

function _hasScriptConsultMessages() {
  var sc = (project && project.scriptConsult) || {};
  return Array.isArray(sc.messages) && sc.messages.length > 0;
}

function _hasRenderedScriptConversation() {
  var box = $("chatMessages");
  if (!box) return false;
  var innerWrap = box.querySelector(".max-w-2xl") || box;
  return !!innerWrap.querySelector(".chat-msg:not(#scriptResultCard)");
}

function _syncScriptWelcomeVisibility() {
  var welcome = $("chatWelcome");
  if (!welcome) return;
  var hasScriptText = !!(project && String(project.script || project.scriptDraft || "").trim());
  var resultCard = $("scriptResultCard");
  var importCard = $("scriptImportDraftCard");
  var hasVisibleDraftCard = !!(
    (resultCard && !resultCard.hidden) ||
    (importCard && !importCard.hidden)
  );
  welcome.hidden = !!(
    hasScriptText ||
    hasVisibleDraftCard ||
    _hasScriptConsultMessages() ||
    _hasRenderedScriptConversation()
  );
}

function _syncScriptDraftMeta() {
  var badge = $("scriptDraftStatusBadge");
  if (!badge) return;
  var approved = !!(project && project.scriptApproved);
  var modified = !!(project && project.scriptReviewState === "modified");
  badge.textContent = approved ? "剧本 · 已确认" : (modified ? "剧本 · 已修改" : "草稿 · 待确认");
  badge.classList.toggle("is-approved", approved);
  badge.classList.toggle("is-modified", !approved && modified);
  badge.classList.toggle("is-pending", !approved && !modified);
}

export function refreshScriptPage() {
  if (!project) return;
  if (_scriptGenerating) return;
  // 委托绑定一次即可（_ensureConfirmDraftDelegation 内部有幂等保护）
  _ensureConfirmDraftDelegation();
  // 回放多轮咨询历史（只在"还没走到正式剧本"阶段做，避免和已有 bible / script 卡重叠）
  _replayScriptConsultHistory();
  var resultCard = $("scriptResultCard");
  var displayText = $("scriptDisplayText");
  var editArea = $("scriptOutput");

  if (project.script) {
    resultCard.hidden = false;
    var _cleanScript = stripStepTags(project.script);
    if (displayText) displayText.textContent = _cleanScript;
    if (editArea) editArea.value = _cleanScript;
    showScriptDisplay();
    _showScriptConfirmArea();
    _scrollChatToBottom();
  } else {
    resultCard.hidden = true;
    _hideScriptConfirmArea();
    if (displayText) displayText.textContent = "";
    if (editArea) editArea.value = "";
  }
  refreshScriptImportDraft();
  _syncScriptDraftMeta();
  _syncScriptWelcomeVisibility();

  renderEmotionSegments();
  renderScriptAnalysis();

  var ideaInput = $("ideaInput");
  if (ideaInput && project && !project.script) ideaInput.value = project.idea || "";
  _updateScriptInputPlaceholder();
  chatAutoResize(ideaInput);
}

function _pendingImportedDraft() {
  if (!project) return "";
  var draft = String(project.scriptDraft || "").trim();
  if (!draft) return "";
  var current = String(project.script || "").trim();
  return draft && draft !== current ? draft : "";
}

export function refreshScriptImportDraft() {
  var card = $("scriptImportDraftCard");
  var textarea = $("scriptDraftPreview");
  if (!card || !textarea) return;
  var draft = _pendingImportedDraft();
  if (!draft) {
    card.hidden = true;
    textarea.value = "";
    _syncScriptWelcomeVisibility();
    return;
  }
  card.hidden = false;
  if (textarea.value !== draft) textarea.value = draft;
  _syncScriptWelcomeVisibility();
}

async function _setImportedDraft(text) {
  if (!project) _ctx.createNewProject && _ctx.createNewProject();
  if (!project || !project.id) return false;
  var originId = project.id;
  _ctx.safeWriteBack(originId, function (proj) {
    proj.scriptDraft = text || "";
  });
  _ctx.saveProject && _ctx.saveProject();
  refreshScriptImportDraft();
  renderScriptAnalysis();
  return true;
}

export async function uploadScriptFile(file) {
  if (!file) return;
  var fname = String(file.name || "").toLowerCase();
  if (!fname.endsWith(".txt") && !fname.endsWith(".md")) {
    showToast("当前仅支持导入 .txt 或 .md 纯文本剧本", "error");
    return;
  }
  try {
    var formData = new FormData();
    formData.append("file", file);
    var headers = {};
    var tk = _ctx.getAuthToken ? _ctx.getAuthToken() : null;
    if (tk) headers["Authorization"] = "Bearer " + tk;
    var resp = await fetch("/api/script/parse-upload", { method: "POST", headers: headers, body: formData });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || data.error) throw new Error(data.error || data.detail || ("导入失败: HTTP " + resp.status));
    var text = String(data.text || "").trim();
    if (!text) { showToast("文件内容为空", "error"); return; }
    var ok = await _setImportedDraft(text);
    if (ok) showToast("剧本已导入为待确认草稿", "success");
  } catch (e) {
    showToast("导入失败: " + ((e && e.message) || e), "error");
  }
}

async function _applyImportedDraft() {
  var textarea = $("scriptDraftPreview");
  var text = String((textarea && textarea.value) || "").trim();
  if (!text) { showToast("导入草稿为空", "warn"); return; }
  if (!project || !project.id) return;
  var originId = project.id;
  var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
    proj.script = text;
    proj.scriptDraft = text;
    proj.scriptApproved = false;
    proj.scriptReviewState = "draft";
    proj.currentStep = Math.max(proj.currentStep || 0, 1);
    proj.emotionSegments = [];
    proj.emotions = [];
    proj.scriptAnalysis = null;
    proj.assets = null;
    proj.assetsApproved = false;
    proj.shots = [];
    proj.shotsApproved = false;
  });
  if (!isCurrent) return;
  var scriptOutput = $("scriptOutput");
  if (scriptOutput) scriptOutput.value = text;
  var resultCard = $("scriptResultCard");
  if (resultCard) {
    resultCard.hidden = false;
    _moveScriptResultToEnd();
  }
  var displayText = $("scriptDisplayText");
  if (displayText) displayText.textContent = text;
  showScriptDisplay();
  refreshScriptImportDraft();
  _syncScriptDraftMeta();
  _showScriptConfirmArea();
  _updateScriptInputPlaceholder();
  renderEmotionSegments();
  renderScriptAnalysis();
  _scrollChatToBottom();
  showToast("已使用导入内容作为剧本草稿，请确认后进入下一步", "success");
}

async function _convertImportedDraft() {
  var textarea = $("scriptDraftPreview");
  var text = String((textarea && textarea.value) || "").trim();
  if (!text) { showToast("导入草稿为空", "warn"); return; }
  if (_scriptGenerating) return;
  var applyBtn = $("btnApplyImportedDraft");
  var convertBtn = $("btnConvertImportedDraft");
  var discardBtn = $("btnDiscardImportedDraft");
  [applyBtn, convertBtn, discardBtn].forEach(function (btn) { if (btn) btn.disabled = true; });
  var oldConvertHtml = convertBtn ? convertBtn.innerHTML : "";
  if (convertBtn) convertBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span><span>转换中</span>';
  try {
    var card = $("scriptImportDraftCard");
    if (card) card.hidden = true;
    _syncScriptWelcomeVisibility();
    await generateScript(text, {
      fromSource: true,
      userMessage: "将导入内容转换为新的剧本草稿",
      sourceHint: false,
    });
  } finally {
    if (convertBtn) convertBtn.innerHTML = oldConvertHtml;
    [applyBtn, convertBtn, discardBtn].forEach(function (btn) { if (btn) btn.disabled = false; });
    refreshScriptImportDraft();
  }
}

function _discardImportedDraft() {
  if (!project || !project.id) return;
  var originId = project.id;
  _ctx.safeWriteBack(originId, function (proj) {
    proj.scriptDraft = proj.script || "";
  });
  _ctx.saveProject && _ctx.saveProject();
  refreshScriptImportDraft();
  renderScriptAnalysis();
  showToast("已放弃导入草稿", "info");
}

var _scriptImportEventsBound = false;
export function initScriptImportEvents() {
  if (_scriptImportEventsBound) return;
  _scriptImportEventsBound = true;
  var uploadBtn = $("btnUploadScript");
  var fileInput = $("scriptFileInput");
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) {
        uploadScriptFile(fileInput.files[0]);
        fileInput.value = "";
      }
    });
  }
  var draftPreview = $("scriptDraftPreview");
  if (draftPreview) {
    draftPreview.addEventListener("input", function () {
      if (!project || !project.id) return;
      var originId = project.id;
      var text = draftPreview.value;
      _ctx.safeWriteBack(originId, function (proj) {
        proj.scriptDraft = text;
      });
      _ctx.saveProject && _ctx.saveProject();
      renderScriptAnalysis();
    });
  }
  var applyBtn = $("btnApplyImportedDraft");
  if (applyBtn) applyBtn.addEventListener("click", function () { _applyImportedDraft(); });
  var convertBtn = $("btnConvertImportedDraft");
  if (convertBtn) convertBtn.addEventListener("click", function () { _convertImportedDraft(); });
  var discardBtn = $("btnDiscardImportedDraft");
  if (discardBtn) discardBtn.addEventListener("click", _discardImportedDraft);
  var analysisBtn = $("btnScriptAnalysisRegen");
  if (analysisBtn) analysisBtn.addEventListener("click", function () { runScriptAnalysis(); });
}

export function showScriptDisplay() {
  var d = $("scriptDisplayText");
  var t = $("scriptOutput");
  if (d) d.classList.remove("hidden");
  if (t) t.classList.add("hidden");
  _syncScriptDraftMeta();
  setScriptEditControls(false);
}

export function showScriptEdit() {
  if (_scriptGenerating) return;
  var d = $("scriptDisplayText");
  var t = $("scriptOutput");
  if (d) d.classList.add("hidden");
  if (t) { t.classList.remove("hidden"); t.focus(); }
  _syncScriptDraftMeta();
  setScriptEditControls(true);
}

function setScriptEditControls(editing) {
  var editBtn = $("btnEditScript");
  var saveBtn = $("btnSaveScriptEdit");
  var cancelBtn = $("btnCancelScriptEdit");
  var confirmBtn = $("btnConfirmScript");
  var inputWrap = $("scriptInputWrap");
  var chipWrap = $("scriptExampleChips");
  if (editBtn) editBtn.hidden = !!editing;
  if (saveBtn) saveBtn.hidden = !editing;
  if (cancelBtn) cancelBtn.hidden = !editing;
  if (inputWrap) inputWrap.hidden = !!editing;
  if (chipWrap) chipWrap.hidden = !!editing;
  var lockTitle = "请先保存或取消剧本编辑";
  var lockedIds = [
    "btnConfirmScript",
    "btnExpandScript",
    "btnUploadScript",
    "btnScriptHeaderRegen",
    "btnGenScript",
    "ideaInput",
  ];
  function setEditLocked(el) {
    if (!el) return;
    if (editing) {
      if (!el.dataset.editLockSavedTitle) {
        el.dataset.editLockSavedTitle = "1";
        el.dataset.editLockTitle = el.getAttribute("title") || "";
      }
      el.disabled = true;
      el.title = lockTitle;
      return;
    }
    el.disabled = false;
    if (el.dataset.editLockSavedTitle) {
      var prevTitle = el.dataset.editLockTitle || "";
      if (prevTitle) el.title = prevTitle;
      else el.removeAttribute("title");
      delete el.dataset.editLockSavedTitle;
      delete el.dataset.editLockTitle;
    } else if (el.title === lockTitle) {
      el.removeAttribute("title");
    }
  }
  lockedIds.forEach(function (id) { setEditLocked($(id)); });
  var chips = document.querySelectorAll(".script-chip");
  chips.forEach(function (chip) { setEditLocked(chip); });
}

function _styleBibleErrorText(source, fallback) {
  var sb = source && source.styleBible ? source.styleBible : source;
  var msg = (source && (source.styleBibleError || source.detail || source.error)) ||
    (sb && (sb._error || sb.error || sb.detail)) ||
    fallback ||
    "风格圣经提取失败，请重新生成";
  return String(msg || "").slice(0, 180);
}

function _isStyleBibleFailed(sb, owner) {
  if (owner && owner.styleBibleStatus === "failed") return true;
  if (!sb || typeof sb !== "object") return false;
  if (sb.styleBibleStatus === "failed" || sb.status === "failed" || sb._error) return true;
  var visual = String(sb.visualStyle || "").trim();
  return visual.indexOf("提取失败") === 0;
}

function _hasStyleBibleContent(sb) {
  if (!sb || typeof sb !== "object") return false;
  if (Array.isArray(sb.colorPalette) && sb.colorPalette.length) return true;
  if (Array.isArray(sb.characters) && sb.characters.length) return true;
  var keys = ["visualStyle", "visualStyleDesc", "era", "mood", "cameraStyle", "lighting", "texture", "editingRhythm", "audio", "subtitleStyle", "dialogueStyle", "worldRules"];
  for (var i = 0; i < keys.length; i++) {
    if (String(sb[keys[i]] || "").trim()) return true;
  }
  return false;
}

function hasUsableStyleBible(sb, owner) {
  return !!(sb && typeof sb === "object" && !_isStyleBibleFailed(sb, owner) && _hasStyleBibleContent(sb));
}

function _isStyleBibleReadyResponse(resp) {
  return !!(resp && resp.styleBibleStatus !== "failed" && hasUsableStyleBible(resp.styleBible, resp));
}

function _styleTemplateIdFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  return String(snapshot.id || snapshot.templateId || snapshot.template_id || "").trim();
}

function _applyStyleBibleResponse(proj, resp) {
  var ready = _isStyleBibleReadyResponse(resp);
  var status = (resp && (resp.styleBibleStatus || (resp.run && resp.run.status))) || "";
  if (ready) proj.styleBible = resp.styleBible;
  else if (resp && resp.styleBible && hasUsableStyleBible(resp.styleBible, resp)) proj.styleBible = resp.styleBible;
  proj.styleBibleStatus = ready ? "ready" : (status === "generating" || status === "queued" || status === "running" || status === "retry_pending" ? "generating" : "failed");
  proj.styleBibleError = ready || proj.styleBibleStatus === "generating" ? ((resp && resp.styleBibleError) || "") : _styleBibleErrorText(resp);
  proj.styleBibleErrorCode = ready ? null : ((resp && (resp.styleBibleErrorCode || (resp.run && resp.run.errorCode))) || null);
  proj.styleBibleGeneratedAt = ready ? (resp.styleBibleGeneratedAt || new Date().toISOString()) : ((resp && resp.styleBibleGeneratedAt) || null);
  proj.styleBibleRunId = resp ? (resp.styleBibleRunId || null) : null;
  proj.styleBibleStartedAt = resp ? (resp.styleBibleStartedAt || proj.styleBibleStartedAt || null) : null;
  proj.styleBibleStage = resp ? (resp.styleBibleStage || (resp.run && resp.run.stage) || null) : null;
  proj.styleBibleProgress = resp ? (resp.styleBibleProgress == null ? proj.styleBibleProgress : resp.styleBibleProgress) : proj.styleBibleProgress;
  proj.styleBibleNextRetryAt = resp ? (resp.styleBibleNextRetryAt || (resp.run && resp.run.nextRetryAt) || null) : null;
  proj.styleBibleHeartbeatAt = resp ? (resp.styleBibleHeartbeatAt || (resp.run && resp.run.heartbeatAt) || null) : null;
  if (ready) {
    proj.styleBibleSourceHash = resp.styleBibleSourceHash || proj.styleBibleSourceHash || null;
    if (Object.prototype.hasOwnProperty.call(resp || {}, "styleOptions")) {
      proj.styleOptions = resp.styleOptions || proj.styleOptions || {};
    } else {
      proj.styleOptions = proj.styleOptions || {};
    }
	    proj.styleBibleRunId = null;
	    proj.styleBibleStartedAt = null;
	    proj.styleBibleStage = null;
	    proj.styleBibleProgress = 100;
	    proj.styleBibleNextRetryAt = null;
	    proj.styleBibleHeartbeatAt = null;
	    proj.styleBibleStaleReason = resp.styleBibleStaleReason || null;
	    proj.styleBibleStaleSince = resp.styleBibleStaleSince || null;
	    proj.styleBibleManuallyEditedAt = resp.styleBibleManuallyEditedAt || null;
	    proj.styleBibleSource = resp.styleBibleSource || "generated";
	    if (Object.prototype.hasOwnProperty.call(resp || {}, "styleBibleGenerationContext")) {
	      proj.styleBibleGenerationContext = resp.styleBibleGenerationContext || null;
	    }
	    if (resp.styleTemplateSnapshot) {
	      proj.styleTemplateSnapshot = resp.styleTemplateSnapshot;
	      var styleTplId = _styleTemplateIdFromSnapshot(resp.styleTemplateSnapshot) ||
	        (resp.styleBibleGenerationContext && resp.styleBibleGenerationContext.styleTemplateId) ||
	        resp.selectedStyleTemplateId;
	      if (!proj.selectedStyleTemplateId && styleTplId) proj.selectedStyleTemplateId = styleTplId;
	    } else if (resp.selectedStyleTemplateId && !proj.selectedStyleTemplateId) {
	      proj.selectedStyleTemplateId = resp.selectedStyleTemplateId;
	    }
	    if (resp.worldTemplateSnapshot) {
	      proj.worldTemplateSnapshot = resp.worldTemplateSnapshot;
	      var worldTplId = _styleTemplateIdFromSnapshot(resp.worldTemplateSnapshot) ||
	        (resp.styleBibleGenerationContext && resp.styleBibleGenerationContext.worldTemplateId) ||
	        resp.selectedWorldTemplateId;
	      if (!proj.selectedWorldTemplateId && worldTplId) proj.selectedWorldTemplateId = worldTplId;
	    } else if (resp.selectedWorldTemplateId && !proj.selectedWorldTemplateId) {
	      proj.selectedWorldTemplateId = resp.selectedWorldTemplateId;
	    }
	  }
  if (ready && proj._staleFlags) delete proj._staleFlags["style_bible"];
  return ready;
}

function _styleBiblePollDelayMs(attempt) {
  if (attempt < 5) return 2000;
  if (attempt < 30) return 5000;
  return 8000;
}

async function _fetchStyleBibleStatus(projectId, runId) {
  var url = "/api/script/workflow/extract-style-bible?projectId=" + encodeURIComponent(projectId);
  if (runId) url += "&runId=" + encodeURIComponent(runId);
  var httpResp = await fetch(url, { headers: getAuthHeaders() });
  var resp = await httpResp.json().catch(function () { return {}; });
  if (!httpResp.ok) {
    var err = new Error(resp.detail || resp.error || ("风格圣经状态读取失败：" + httpResp.status));
    err.status = httpResp.status;
    err.payload = resp;
    throw err;
  }
  return resp;
}

async function _waitStyleBibleReady(originId, initialResp) {
  var runId = initialResp && initialResp.styleBibleRunId;
  var deadline = Date.now() + 30 * 60 * 1000;
  var attempt = 0;
  var latest = initialResp;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, _styleBiblePollDelayMs(attempt++)); });
    latest = await _fetchStyleBibleStatus(originId, runId);
    var appliedReady = false;
    _ctx.safeWriteBack(originId, function (proj) {
      appliedReady = _applyStyleBibleResponse(proj, latest);
    });
    if (appliedReady) return latest;
    if (latest && latest.styleBibleStatus === "failed") {
      var err = new Error(_styleBibleErrorText(latest, "风格圣经生成失败"));
      err.payload = latest;
      throw err;
    }
  }
  var timeout = new Error("风格圣经生成仍在进行，可稍后查看或重新生成");
  timeout.status = 408;
  timeout.payload = latest;
  throw timeout;
}

function _analysisShortText(text, fallback, maxLen) {
  var s = String(text || fallback || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  maxLen = maxLen || 80;
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function _analysisScriptText() {
  if (!project) return "";
  return stripStepTags(project.script || project.scriptDraft || "").trim();
}

function _analysisSourceHash(text) {
  var hash = 0;
  var s = String(text || "");
  for (var i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return String(s.length) + ":" + String(hash >>> 0);
}

function _analysisScriptLines(text) {
  return String(text || "").split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
}

function _analysisDialogueLines(lines) {
  return lines.filter(function (line) {
    return /^[^：:]{1,14}[：:]/.test(line) || /[“"][^”"]+[”"]/.test(line);
  });
}

function _analysisExtractSpeakers(lines) {
  var seen = {};
  var out = [];
  lines.forEach(function (line) {
    var m = line.match(/^([^：:]{1,14})[：:]/);
    if (!m) return;
    var name = m[1].replace(/[【】\[\]（()]/g, "").trim();
    if (!name || seen[name]) return;
    seen[name] = true;
    out.push({ name: name, role: "对白角色", desire: "目标待分析", pressure: "阻力待分析" });
  });
  return out.slice(0, 5);
}

function _analysisCharacters(lines) {
  var sbChars = project && project.styleBible && Array.isArray(project.styleBible.characters) ? project.styleBible.characters : [];
  if (sbChars.length) {
    return sbChars.slice(0, 5).map(function (ch) {
      var name = String((ch && ch.name) || "未命名").trim() || "未命名";
      return {
        name: name,
        role: _analysisShortText((ch && (ch.role || ch.description || ch.appearance)) || "主要出场角色", "主要出场角色", 24),
        desire: _analysisShortText((ch && ch.desire) || "围绕主冲突推进选择", "围绕主冲突推进选择", 26),
        pressure: _analysisShortText((ch && ch.pressure) || "受到环境、关系或反转压力牵引", "受到环境、关系或反转压力牵引", 28),
      };
    });
  }
  return _analysisExtractSpeakers(lines);
}

function _analysisCore(lines, text) {
  var first = lines[0] || "";
  var second = lines[1] || "";
  var conflict = lines.find(function (line) { return /却|但是|突然|发现|必须|危机|冲突|反转|争/.test(line); }) || second || first;
  var promise = lines.find(function (line) { return /最后|终于|原来|结果|反转|真相|高潮|发现/.test(line); }) || lines[lines.length - 1] || first;
  return {
    logline: _analysisShortText(first.replace(/^[^：:]{1,8}[：:]/, ""), text ? "当前剧本已就绪，等待进一步分析。" : "", 92),
    conflict: _analysisShortText(conflict.replace(/^[^：:]{1,8}[：:]/, ""), "核心冲突待分析", 92),
    audiencePromise: _analysisShortText(promise.replace(/^[^：:]{1,8}[：:]/, ""), "观众期待点待分析", 92),
  };
}

function _analysisPacing() {
  var segs = (project && project.emotionSegments) || [];
  if (!Array.isArray(segs) || !segs.length) return [];
  return segs.slice(0, 5).map(function (seg, idx) {
    var lv = Math.max(1, Math.min(5, Number(seg.intensity) || 3));
    return {
      label: EMOTION_LABEL_CN[seg.emotion] || seg.title || ("段落 " + (idx + 1)),
      pacing: PACING_LABEL_CN[seg.pacing] || seg.pacing || "节奏待定",
      intensity: lv,
      note: _analysisShortText(seg.note || seg.paragraphStart || "", "情绪说明待补充", 54),
    };
  });
}

function _analysisProjectShots() {
  var shots = project && Array.isArray(project.shots) ? project.shots : [];
  return shots.filter(function (shot) { return shot && typeof shot === "object"; });
}

function _analysisShotDuration(shot) {
  if (!shot) return 0;
  var raw = shot.duration;
  if (raw == null || raw === "") raw = shot.durationSec;
  var n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function _analysisDefaultPhases() {
  return [
    { label: "开场建立", note: "建立空间、主角和第一眼钩子。" },
    { label: "冲突递进", note: "用动作或对白把问题推到台前。" },
    { label: "关键转折", note: "集中呈现反转、选择或信息揭示。" },
    { label: "情绪落点", note: "让人物反应承接高潮后的变化。" },
    { label: "收束余韵", note: "留出结尾记忆点或下一步悬念。" },
  ];
}

function _analysisPhaseForShot(idx, total) {
  var phases = _analysisDefaultPhases();
  if (!total) return phases[0];
  var phaseIdx = Math.min(phases.length - 1, Math.floor((idx / total) * phases.length));
  return phases[phaseIdx];
}

function _analysisShotPhaseLabel(shot, idx, total) {
  var emotion = shot && (shot.emotion || shot.phase || shot.storyPhase || "");
  if (emotion && EMOTION_LABEL_CN[emotion]) return EMOTION_LABEL_CN[emotion];
  if (emotion) return _analysisShortText(emotion, "", 12);
  return _analysisPhaseForShot(idx, total).label;
}

function _analysisShotNote(shot, fallback) {
  return _analysisShortText(
    shot && (shot.keyInfo || shot.sceneName || shot.visual || shot.description || shot.scriptRef || shot.dialogue),
    fallback || "镜头重点待细化",
    58
  );
}

function _analysisShotPoint(shot) {
  if (!shot) return "";
  var raw = shot.keyInfo || shot.sceneName || shot.scriptRef || shot.dialogue || shot.visual || shot.description || "";
  raw = String(raw || "")
    .replace(/^[^：:]{1,10}[：:]\s*/, "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw || raw === "——") return "";
  return _analysisShortText(raw, "", 16);
}

function _analysisStructureIntent(label, idx) {
  var s = String(label || "");
  if (/铺垫|开场|建立|setup/i.test(s)) return "建立空间与规则";
  if (/升温|递进|rising/i.test(s)) return "加压冲突与期待";
  if (/过渡|连接|转折/.test(s)) return "衔接关键变化";
  if (/高潮|climax/i.test(s)) return "集中释放反转";
  if (/回落|收束|余韵|falling|resolution/i.test(s)) return "承接结果与追问";
  return ["建立观看入口", "推进事件压力", "承接关键变化", "放大核心看点", "收住情绪落点"][idx] || "补充段落功能";
}

function _analysisStructureNote(group, idx) {
  var points = Array.isArray(group.points) ? group.points.slice(0, 3).filter(Boolean).join("、") : "";
  var duration = group.durationSec ? ("约" + String(group.durationSec) + "s") : "";
  var intent = _analysisStructureIntent(group.label, idx);
  var lead = [duration, points].filter(Boolean).join(" · ");
  if (lead) return _analysisShortText(lead + "；" + intent + "。", "", 72);
  return _analysisShortText(group.note, intent + "。", 72);
}

function _analysisDistributeCount(total, bucketCount) {
  var count = Math.max(1, Math.round(Number(total) || 1));
  var buckets = Math.max(1, bucketCount || 1);
  var base = Math.floor(count / buckets);
  var rem = count % buckets;
  var out = [];
  for (var i = 0; i < buckets; i++) out.push(base + (i < rem ? 1 : 0));
  return out;
}

function _analysisSuggestedShotCount(lines, stats) {
  var duration = Number(stats && stats.estimatedDurationSec) || 0;
  var dialogueCount = Number(stats && stats.dialogueLines) || 0;
  var byDuration = duration ? Math.round(duration / 5) : 0;
  var byDialogue = dialogueCount ? Math.ceil(dialogueCount / 2) : 0;
  var byLines = lines && lines.length ? Math.ceil(lines.length / 3) : 0;
  var raw = Math.max(byDuration, byDialogue, byLines, 8);
  var max = duration > 90 ? 24 : 12;
  return Math.max(6, Math.min(max, raw));
}

function _analysisActualShotStructure(shots) {
  var groups = [];
  var map = {};
  var total = shots.length;
  shots.forEach(function (shot, idx) {
    var label = _analysisShotPhaseLabel(shot, idx, total);
    var key = label || ("阶段 " + (groups.length + 1));
    if (!map[key]) {
      map[key] = { label: key, count: 0, note: "", points: [], durationSec: 0 };
      groups.push(map[key]);
    }
    map[key].count += 1;
    map[key].durationSec += _analysisShotDuration(shot);
    var point = _analysisShotPoint(shot);
    if (point && map[key].points.indexOf(point) === -1 && map[key].points.length < 3) {
      map[key].points.push(point);
    }
    if (!map[key].note) map[key].note = _analysisShotNote(shot, _analysisPhaseForShot(idx, total).note);
  });
  return groups.slice(0, 5).map(function (group, idx) {
    return {
      label: group.label,
      count: group.count,
      durationSec: group.durationSec,
      note: _analysisStructureNote(group, idx),
    };
  });
}

function _analysisEstimatedShotStructure(count, pacing) {
  var base = Array.isArray(pacing) && pacing.length ? pacing.slice(0, 5) : _analysisDefaultPhases();
  var counts = _analysisDistributeCount(count, base.length);
  return base.map(function (seg, idx) {
    var fallback = _analysisDefaultPhases()[idx] || _analysisDefaultPhases()[0];
    return {
      label: seg.label || fallback.label,
      count: counts[idx] || 1,
      note: _analysisShortText((seg.note || fallback.note) + "；" + _analysisStructureIntent(seg.label || fallback.label, idx) + "。", fallback.note, 72),
    };
  });
}

function _analysisShotOverview(lines, stats, pacing) {
  var shots = _analysisProjectShots();
  var hasActual = shots.length > 0;
  var suggestedCount = _analysisSuggestedShotCount(lines, stats);
  var totalDuration = 0;
  if (hasActual) {
    shots.forEach(function (shot) { totalDuration += _analysisShotDuration(shot); });
  }
  if (!totalDuration) totalDuration = Number(stats && stats.estimatedDurationSec) || 0;
  return {
    source: hasActual ? "镜头计划" : "剧本估算",
    count: hasActual ? shots.length : suggestedCount,
    metricLabel: hasActual ? "已生成" : "建议",
    totalDurationSec: totalDuration,
    structure: hasActual ? _analysisActualShotStructure(shots) : _analysisEstimatedShotStructure(suggestedCount, pacing),
  };
}

function _analysisKeyBeats(lines) {
  var picked = lines.filter(function (line) {
    return /突然|发现|原来|最后|终于|反转|真相|危机|高潮|决定|必须/.test(line);
  });
  if (!picked.length) picked = lines.slice(0, 4);
  return picked.slice(0, 4).map(function (line, idx) {
    var titles = ["开场钩子", "冲突升级", "关键转折", "收束回响"];
    return {
      title: titles[idx] || ("看点 " + (idx + 1)),
      detail: _analysisShortText(line.replace(/^[^：:]{1,8}[：:]/, ""), "关键剧情点待分析", 70),
    };
  });
}

function _analysisNotes(stats, pacing) {
  var notes = [];
  if (stats.estimatedDurationSec > 75) notes.push("篇幅偏长，后续若面向短视频可重点压缩铺垫。");
  if (stats.dialogueLines < 2) notes.push("对白信息较少，右栏先按叙述段落识别剧情重点。");
  if (!pacing.length) notes.push("尚未生成情绪段，当前节奏结构为本地简版摘要。");
  if (!notes.length) notes.push("结构信息已具备，可继续在工作台修改剧本内容。");
  return notes.slice(0, 3);
}

function _buildLocalScriptAnalysis() {
  var text = _analysisScriptText();
  var lines = _analysisScriptLines(text);
  var dialogue = _analysisDialogueLines(lines);
  var pacing = _analysisPacing();
  var stats = {
    chars: text.length,
    estimatedDurationSec: project && project.scriptTargetDurationSec ? Number(project.scriptTargetDurationSec) : Math.max(15, Math.round(text.length / 4.2)),
    dialogueLines: dialogue.length,
    segmentCount: pacing.length || Math.min(5, Math.max(1, Math.ceil(lines.length / 4))),
  };
  return {
    schemaVersion: "local-v1",
    sourceHash: _analysisSourceHash(text),
    generatedAt: null,
    stats: stats,
    shotOverview: _analysisShotOverview(lines, stats, pacing),
    core: _analysisCore(lines, text),
    pacing: pacing,
    characters: _analysisCharacters(lines),
    keyBeats: _analysisKeyBeats(lines),
    notes: _analysisNotes(stats, pacing),
  };
}

function _cachedScriptAnalysis(text) {
  var cached = project && project.scriptAnalysis && typeof project.scriptAnalysis === "object" ? project.scriptAnalysis : null;
  if (!cached) return null;
  return cached.sourceHash === _analysisSourceHash(text) ? cached : null;
}

function _hasStaleScriptAnalysis(text) {
  var cached = project && project.scriptAnalysis && typeof project.scriptAnalysis === "object" ? project.scriptAnalysis : null;
  return !!(cached && cached.sourceHash && cached.sourceHash !== _analysisSourceHash(text));
}

function _analysisModuleHead(icon, title, en, chip) {
  return '<div class="script-analysis-module-head">' +
    '<div class="script-analysis-module-title">' +
      '<span class="material-symbols-outlined">' + icon + '</span>' +
      '<span class="script-analysis-title-cn">' + title + '</span>' +
      '<span class="script-analysis-title-en">' + en + '</span>' +
    '</div>' +
    (chip ? '<span class="script-analysis-chip">' + escapeHtml(chip) + '</span>' : '') +
  '</div>';
}

function _renderAnalysisMetrics(stats) {
  return '<div class="script-analysis-metrics">' +
    '<div><strong>' + escapeHtml(String(stats.chars || 0)) + '</strong><span>字数</span></div>' +
    '<div><strong>' + escapeHtml(String(stats.estimatedDurationSec || 0)) + 's</strong><span>预计</span></div>' +
    '<div><strong>' + escapeHtml(String(stats.dialogueLines || 0)) + '</strong><span>对白</span></div>' +
    '<div><strong>' + escapeHtml(String(stats.segmentCount || 0)) + '</strong><span>段落</span></div>' +
  '</div>';
}

function _renderAnalysisShotOverview(overview) {
  overview = overview || {};
  var structure = Array.isArray(overview.structure) ? overview.structure : [];
  var duration = Number(overview.totalDurationSec) || 0;
  var rows = structure.length ? structure.map(function (seg) {
    return '<div class="script-analysis-structure-row">' +
      '<span class="script-analysis-structure-count">' + escapeHtml(String(seg.count || 0)) + '镜</span>' +
      '<div class="script-analysis-structure-body">' +
        '<strong>' + escapeHtml(seg.label || "阶段待定") + '</strong>' +
        '<p>' + escapeHtml(seg.note || "镜头重点待细化") + '</p>' +
      '</div>' +
    '</div>';
  }).join("") : '<p class="script-analysis-muted">镜头结构待生成，确认剧本后可进入镜头计划细化。</p>';
  return '<div class="script-analysis-card script-analysis-card--shots">' +
    _analysisModuleHead('videocam', '镜头结构', 'SHOTS', overview.source || '剧本估算') +
    '<div class="script-analysis-summary-grid">' +
      '<div><i class="material-symbols-outlined">track_changes</i><strong>' + escapeHtml(String(overview.count || 0)) + '</strong><span>' + escapeHtml(overview.metricLabel || "建议") + '镜头</span></div>' +
      '<div><i class="material-symbols-outlined">schedule</i><strong>' + escapeHtml(duration ? String(duration) + "s" : "待定") + '</strong><span>计划时长</span></div>' +
      '<div><i class="material-symbols-outlined">layers</i><strong>' + escapeHtml(String(structure.length || 0)) + '</strong><span>结构段</span></div>' +
    '</div>' +
    '<div class="script-analysis-structure">' + rows + '</div>' +
  '</div>';
}

function _renderAnalysisCore(core, stats) {
  return '<div class="script-analysis-card">' +
    _analysisModuleHead('target', '故事核心', 'CORE', '只读') +
    _renderAnalysisMetrics(stats) +
    '<dl class="script-analysis-list">' +
      '<div><dt>一句话</dt><dd>' + escapeHtml(core.logline || "待生成剧本内容") + '</dd></div>' +
      '<div><dt>主冲突</dt><dd>' + escapeHtml(core.conflict || "待分析") + '</dd></div>' +
      '<div><dt>期待点</dt><dd>' + escapeHtml(core.audiencePromise || "待分析") + '</dd></div>' +
    '</dl>' +
  '</div>';
}

function _renderAnalysisPacing(pacing) {
  var body = "";
  if (pacing.length) {
    body = '<div class="script-analysis-pacing">' + pacing.map(function (seg) {
      return '<div class="script-analysis-pace-row">' +
        '<div class="script-analysis-pace-top"><span>' + escapeHtml(seg.label) + '</span><em>' + escapeHtml(seg.pacing) + '</em></div>' +
        '<div class="script-analysis-pace-bar"><i style="width:' + escapeHtml(String(seg.intensity * 20)) + '%"></i></div>' +
        '<p>' + escapeHtml(seg.note) + '</p>' +
      '</div>';
    }).join("") + '</div>';
  } else {
    body = '<p class="script-analysis-muted">情绪段尚未生成，确认或重新分析情绪后会显示五段式节奏。</p>';
  }
  return '<div class="script-analysis-card">' +
    _analysisModuleHead('timeline', '节奏结构', 'PACING', pacing.length ? '情绪段' : '') +
    body +
  '</div>';
}

function _renderAnalysisCharacters(chars) {
  var body = "";
  if (chars.length) {
    body = '<div class="script-analysis-characters">' + chars.map(function (ch) {
      var name = String(ch.name || "角").trim() || "角";
      return '<article class="script-analysis-character">' +
        '<div class="script-analysis-character-avatar">' + escapeHtml(name.charAt(0)) + '</div>' +
        '<div class="script-analysis-character-body">' +
          '<strong>' + escapeHtml(name) + '</strong>' +
          '<span>' + escapeHtml(ch.role || "主要角色") + '</span>' +
          '<p>' + escapeHtml(ch.desire || "目标待分析") + ' / ' + escapeHtml(ch.pressure || "阻力待分析") + '</p>' +
        '</div>' +
      '</article>';
    }).join("") + '</div>';
  } else {
    body = '<p class="script-analysis-muted">暂未识别到明确角色，可在剧本中使用“角色名：台词”增强识别。</p>';
  }
  return '<div class="script-analysis-card">' +
    _analysisModuleHead('groups', '角色定位', 'CHARACTERS', chars.length ? (String(chars.length) + ' 角色') : '') +
    body +
  '</div>';
}

function _renderAnalysisBeats(beats) {
  return '<div class="script-analysis-card">' +
    _analysisModuleHead('bolt', '关键看点', 'KEY BEATS', '') +
    '<div class="script-analysis-beats">' + beats.map(function (beat, idx) {
      return '<div class="script-analysis-beat">' +
        '<span>' + String(idx + 1) + '</span>' +
        '<div><strong>' + escapeHtml(beat.title || ("看点 " + (idx + 1))) + '</strong><p>' + escapeHtml(beat.detail || "待分析") + '</p></div>' +
      '</div>';
    }).join("") + '</div>' +
  '</div>';
}

function _renderAnalysisNotes(notes) {
  return '<div class="script-analysis-card">' +
    _analysisModuleHead('fact_check', '阅读提醒', 'NOTES', '') +
    '<ul class="script-analysis-notes">' + notes.map(function (note) {
      return '<li>' + escapeHtml(note) + '</li>';
    }).join("") + '</ul>' +
  '</div>';
}

function _renderAnalysisStaleBanner() {
  return '<div class="script-analysis-stale">' +
    '<span class="material-symbols-outlined">warning</span>' +
    '<span>剧本已修改，剧本分析可能与当前文本不一致。右侧已先显示本地摘要，可点击重新分析刷新。</span>' +
  '</div>';
}

export function renderScriptAnalysis() {
  var el = $("scriptAnalysisPreview");
  var regen = $("btnScriptAnalysisRegen");
  if (!el) return;
  var text = _analysisScriptText();
  if (regen) regen.disabled = !text;
  if (!text) {
    el.innerHTML = '<div class="script-analysis-empty">' +
      '<span class="material-symbols-outlined">insights</span>' +
      '<h3>等待剧本草稿</h3>' +
      '<p>生成或导入剧本后，这里会优先展示镜头数量/结构、角色数量/定位，再补充故事核心和节奏看点。</p>' +
    '</div>';
    return;
  }
  var localAnalysis = _buildLocalScriptAnalysis();
  var cached = _cachedScriptAnalysis(text);
  var analysis = cached || localAnalysis;
  analysis.stats = analysis.stats || localAnalysis.stats;
  analysis.shotOverview = localAnalysis.shotOverview;
  analysis.core = analysis.core || localAnalysis.core;
  analysis.pacing = Array.isArray(analysis.pacing) ? analysis.pacing : localAnalysis.pacing;
  analysis.characters = Array.isArray(analysis.characters) ? analysis.characters : localAnalysis.characters;
  analysis.keyBeats = Array.isArray(analysis.keyBeats) ? analysis.keyBeats : localAnalysis.keyBeats;
  analysis.notes = Array.isArray(analysis.notes) ? analysis.notes : localAnalysis.notes;
  var staleHtml = _hasStaleScriptAnalysis(text) ? _renderAnalysisStaleBanner() : "";
  el.innerHTML =
    staleHtml +
    _renderAnalysisCore(analysis.core, analysis.stats) +
    _renderAnalysisShotOverview(analysis.shotOverview) +
    _renderAnalysisCharacters(analysis.characters) +
    _renderAnalysisPacing(analysis.pacing) +
    _renderAnalysisBeats(analysis.keyBeats) +
    _renderAnalysisNotes(analysis.notes);
}

export async function runScriptAnalysis() {
  if (!project || !project.id) { showToast("请先创建或选择项目", "warn"); return; }
  var text = _analysisScriptText();
  if (!text) { showToast("请先生成或导入剧本", "warn"); return; }
  var originId = project.id;
  var btn = $("btnScriptAnalysisRegen");
  var oldHtml = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span><span>分析中</span>';
  }
  try {
    var resp = await apiPost("/api/script/workflow/analyze", {
      projectId: originId,
      script: text,
      durationSec: project.scriptTargetDurationSec || null,
    });
    if (resp && resp.detail && !resp.scriptAnalysis) throw new Error(resp.detail);
    if (!resp || !resp.scriptAnalysis) throw new Error("分析结果为空");
    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
      proj.scriptAnalysis = resp.scriptAnalysis;
    });
    if (isCurrent) {
      renderScriptAnalysis();
      if (resp.scriptAnalysisStatus === "degraded") {
        var hint = resp.scriptAnalysisError ? "：" + resp.scriptAnalysisError : "";
        showToast("模型分析暂不可用" + hint + "，已刷新本地摘要", "warn");
      } else {
        showToast("剧本分析已刷新", "success");
      }
    }
  } catch (e) {
    var errText = _scriptErrorText(e);
    showToast("剧本分析失败: " + errText, "error");
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    if (btn) {
      btn.innerHTML = oldHtml || '<span class="material-symbols-outlined">auto_awesome</span><span>重新分析</span>';
      btn.disabled = !(_analysisScriptText());
    }
  }
}

export async function handleScriptInput() {
  if (_scriptGenerating) return;
  if (_pendingSourceChoice && !document.querySelector(".source-choice-card")) {
    _pendingSourceChoice = false;
  }
  if (_pendingSourceChoice) {
    showToast("请先选择这段内容的处理方式", "warn");
    return;
  }
  var idea = $("ideaInput").value.trim();
  if (!idea) { showToast("请输入内容", "warn"); return; }
  if (!project) _ctx.createNewProject && _ctx.createNewProject();

  var hasScript = project && project.script && project.script.trim();
  if (hasScript) {
    // 已有剧本 → 走改本
    await reviseScript(idea);
  } else {
    var sourceClass = _classifySourceTextInput(idea);
    if (sourceClass === "high") {
      await generateScript(idea, { fromSource: true });
    } else if (sourceClass === "low") {
      _promptSourceOrConsult(idea);
    } else {
      // 还没剧本 → 多轮咨询（后端 run_consult_turn 判断信息够不够，够就给大纲 + ready）
      await _consultTurn(idea);
    }
  }
}

function _classifySourceTextInput(text) {
  text = (text || "").trim();
  if (!text) return "none";
  var len = text.length;
  var quotePairs = _countRegexMatches(text, /[“"][^”"]{2,}[”"]/g);
  var stageDirections = _countRegexMatches(text, /（[^）]{4,}）|\([^)]{4,}\)/g);
  var paragraphCount = text.split(/\n+/).map(function (line) { return line.trim(); }).filter(function (line) { return line.length >= 12; }).length;
  var validDialogueLines = _countSourceDialogueLines(text);
  var hasStrongMarkers = /(第[一二三四五六七八九十百\d]+[章节幕场]|内景|外景|转场|画外音)/.test(text);
  if (hasStrongMarkers && len >= 120) return "high";
  if (quotePairs >= 3 && len >= 200) return "high";
  if (stageDirections >= 2 && len >= 200) return "high";
  if (validDialogueLines >= 3 && len >= 220) return "high";
  if (len >= 800) return "low";
  if (len >= 400 && paragraphCount >= 6) return "low";
  if (len >= 500 && paragraphCount >= 3 && (quotePairs >= 1 || validDialogueLines >= 1 || /突然|随后|沉默|看着|走进/.test(text))) return "low";
  return "none";
}

function _countRegexMatches(text, regex) {
  var matches = text.match(regex);
  return matches ? matches.length : 0;
}

function _countSourceDialogueLines(text) {
  var metaPrefix = /^(需求|目标|人设|主题|风格|背景|时长|平台|受众|备注|要求)\s*$/;
  var lines = String(text || "").split(/\n+/);
  var count = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var match = line.match(/^([^：:\n]{1,12})[：:](.+)$/);
    if (!match) continue;
    var speaker = match[1].trim();
    var body = match[2].trim();
    if (metaPrefix.test(speaker)) continue;
    if (/需求|说明|段落|大纲|设定|限制|参考/.test(speaker)) continue;
    if (body.length < 6) continue;
    if (/[。！？!?」』”"]$/.test(body) || /[“"][^”"]{2,}[”"]/.test(body)) count++;
  }
  return count;
}

function _promptSourceOrConsult(idea) {
  _pendingSourceChoice = true;
  var input = $("ideaInput");
  if (input) {
    input.value = "";
    chatAutoResize(input);
  }
  var msg = chatAddMsg("status",
    '<div class="source-choice-card">' +
      '<div class="source-choice-card__title">这段内容比较长，像是已有原文/小说片段。</div>' +
      '<div class="source-choice-card__text">你想怎么处理？</div>' +
      '<div class="source-choice-card__actions">' +
        '<button type="button" class="source-choice-card__btn source-choice-card__btn--primary" data-source-choice="adapt">直接生成剧本草稿</button>' +
        '<button type="button" class="source-choice-card__btn" data-source-choice="consult">继续走创意咨询</button>' +
      '</div>' +
    '</div>');
  var card = msg && msg.querySelector(".source-choice-card");
  if (!card) {
    _pendingSourceChoice = false;
    _consultTurn(idea);
    return;
  }
  card.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-source-choice]");
    if (!btn) return;
    if (_scriptGenerating || btn.disabled || card.dataset.locked === "1") return;
    card.dataset.locked = "1";
    var buttons = card.querySelectorAll("button");
    buttons.forEach(function (button) { button.disabled = true; });
    _pendingSourceChoice = false;
    var choice = btn.dataset.sourceChoice;
    var wrapper = msg;
    if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    if (choice === "adapt") {
      generateScript(idea, { fromSource: true }).catch(function () { /* handled inside generateScript */ });
    } else {
      _consultTurn(idea).catch(function () { /* handled inside _consultTurn */ });
    }
  });
}

// ── 多轮咨询：发一轮消息（用户侧） ────────────────────────────────────
//
// 走后端 `/api/script/workflow/consult/turn` SSE。前端只做三件事：
//   1. 渲染用户消息 + AI 气泡（流式打字）
//   2. done 时如果 `evt.readyToDraft && !shouldAutoTrigger`，挂一颗
//      "确认生成剧本 →" 按钮到 AI 气泡末尾
//   3. done 时如果 `evt.shouldAutoTrigger`（用户本轮消息已含确认意图且 AI 给出大纲），
//      自动调 `_consultConfirm()` 进入正式生成
//
// 业务态（对话历史、ready 标记、confirmedAt）**不在前端存**——后端 project.json
// 是权威，刷新后 `refreshScriptPage` 从 `project.scriptConsult.messages` 回放。
async function _consultTurn(userMsg, options) {
  options = options || {};
  var originId = project ? project.id : null;
  if (!originId) return;
  var guard = _newScriptRequestGuard(originId, "consult_turn");
  _scriptGenerating = true;
  $("btnGenScript").disabled = true;
  $("ideaInput").value = "";
  chatAutoResize($("ideaInput"));
  if (!options.skipUserBubble) chatAddMsg("user", escapeHtml(userMsg));

  var aiMsg = chatAddMsg("ai", "");
  var bubble = aiMsg && aiMsg.querySelector(".chat-bubble--ai");

  try {
    var resp = await apiPostStream("/api/script/workflow/consult/turn", {
      projectId: originId,
      message: userMsg,
      creatorProfile: _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null,
    }, null, function (evt) {
      if (!_isScriptRequestCurrent(guard)) return;
      if (evt.type === "ai_chunk") {
        if (bubble) bubble.textContent += evt.content || "";
        _scrollChatToBottom();
      }
    }, guard.controller ? { signal: guard.controller.signal } : null);

    if (!_isScriptRequestCurrent(guard)) return;

    // done 时 bubble 文本就是流式累加后的纯文本；后端已在 done payload 里
    // 给出剥干净 ready 标记的 aiMessage，用它做权威显示，避免前端自己再截标记。
    if (bubble && resp.aiMessage) bubble.textContent = resp.aiMessage;

    if (resp.readyToDraft && bubble) {
      // AI 给了大纲 + ready → 在气泡末尾挂"确认生成剧本 →"按钮
      _appendConfirmDraftButton(bubble);
    }
  } catch (e) {
    if (!_isScriptRequestCurrent(guard) || (e && e.name === "AbortError")) return;
    var errText = _scriptErrorText(e);
    if (bubble) bubble.textContent = "";
    chatAddMsg("status", '<span class="chat-status-err">咨询失败: ' + escapeHtml(errText) + '</span>');
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    if (_isScriptRequestCurrent(guard)) {
      _scriptGenerating = false;
      $("btnGenScript").disabled = false;
    }
    _finishScriptRequest(guard);
  }
}

function _appendConfirmDraftButton(bubbleEl) {
  if (!bubbleEl) return;
  // 避免重复挂
  if (bubbleEl.querySelector(".btn-confirm-draft")) return;
  var wrap = document.createElement("div");
  wrap.className = "chat-confirm-draft-wrap";
  wrap.innerHTML = '<button type="button" class="btn-confirm-draft">确认生成剧本 →</button>';
  bubbleEl.appendChild(wrap);
}

// 事件委托：所有"确认生成剧本"按钮共用一个监听器，方便历史回放出的按钮
// 也能响应。注册一次即可，`_consultTurn` / `refreshScriptPage` 多次调用不会重复绑。
var _confirmDraftDelegated = false;
function _ensureConfirmDraftDelegation() {
  if (_confirmDraftDelegated) return;
  var chatBox = $("chatMessages");
  if (!chatBox) return;
  chatBox.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".btn-confirm-draft");
    if (!btn) return;
    if (_scriptGenerating) return;
    btn.disabled = true;
    btn.textContent = "生成中…";
    _consultConfirm().catch(function () { /* 错误在 _consultConfirm 内部已处理 */ });
  });
  _confirmDraftDelegated = true;
}

// ── 多轮咨询：用户确认后走正式生成 ────────────────────────────────────
//
// 调后端 `/api/script/workflow/consult/confirm` SSE。这个端点只负责把咨询
// 大纲生成剧本草稿和情绪段；风格圣经必须在「风格制定」页显式生成。
async function _consultConfirm() {
  if (!project) return;
  var originId = project.id;
  var guard = _newScriptRequestGuard(originId, "consult_confirm");

  _scriptGenerating = true;
  $("btnGenScript").disabled = true;

  // UI 准备：跟 generateScript 一样拉出 scriptResultCard、清空显示、锁打字区等
  var displayText = $("scriptDisplayText");
  var editArea = $("scriptOutput");
  var editBtn = $("btnEditScript");
  var expandBtn = $("btnExpandScript");
  var resultCard = $("scriptResultCard");
  if (resultCard) {
    resultCard.hidden = false;
    _moveScriptResultToEnd();
  }
  if (displayText) { displayText.textContent = ""; displayText.style.pointerEvents = "none"; displayText.classList.add("streaming-wave"); }
  if (editArea) editArea.value = "";
  if (editBtn) editBtn.hidden = true;
  if (expandBtn) expandBtn.hidden = true;
  _hideScriptConfirmArea();
  showScriptDisplay();
  _scrollChatToBottom();

  var _userScrolledUp = false;
  var chatBox = $("chatMessages");
  function _onUserScroll() {
    if (!chatBox) return;
    var atBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;
    _userScrolledUp = !atBottom;
  }
  if (chatBox) chatBox.addEventListener("scroll", _onUserScroll);

  var _stepState = { buf: "" };
  var stepEl = $("scriptStreamStep");
  if (stepEl) { stepEl.hidden = true; stepEl.textContent = ""; }
  try {
    var resp = await apiPostStream("/api/script/workflow/consult/confirm", {
      projectId: originId,
      durationSec: (project && project.scriptTargetDurationSec) || null,
      creatorProfile: _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null,
    }, null, function (evt) {
      if (!_isScriptRequestCurrent(guard)) return;
      if (evt.type === "script_chunk") {
        var raw = evt.content || "";
        var clean = consumeStreamStepTags(raw, _stepState, function (hint) {
          if (stepEl) { stepEl.hidden = false; stepEl.textContent = "AI · " + hint; }
        });
        if (displayText) displayText.textContent += clean;
        if (!_userScrolledUp) _scrollChatToBottom();
      }
    }, guard.controller ? { signal: guard.controller.signal } : null);

    if (!_isScriptRequestCurrent(guard)) return;

	    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
		      proj.script = resp.script || "";
		      proj.scriptDraft = resp.script || "";
		      proj.scriptApproved = false;
		      proj.scriptReviewState = "draft";
	      proj.emotionSegments = Array.isArray(resp.emotionSegments) ? resp.emotionSegments : [];
	      proj.scriptTargetDurationSec = resp.durationSec || proj.scriptTargetDurationSec || null;
	      proj.assets = null;
      proj.assetsApproved = false;
      proj.shots = [];
      proj.shotsApproved = false;
    });

    if (isCurrent) {
	      if (displayText) { displayText.textContent = resp.script; displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
	      if (editArea) editArea.value = resp.script;
	      refreshScriptImportDraft();
	      _syncScriptDraftMeta();
	      if (editBtn) editBtn.hidden = false;
      if (expandBtn) expandBtn.hidden = false;
      _scrollChatToBottom();
      _updateScriptInputPlaceholder();
      if (stepEl) stepEl.hidden = true;
		      chatRemoveDots();
      _showScriptConfirmArea();
      chatAddMsg("status", '<span class="chat-status-ok">剧本草稿已生成。请确认剧本后，到「风格制定」页选择画幅和模板，再生成风格圣经。</span>');
		      renderEmotionSegments();
	      renderScriptAnalysis();
		    }
  } catch (e) {
    if (!_isScriptRequestCurrent(guard) || (e && e.name === "AbortError")) return;
    if (stepEl) stepEl.hidden = true;
    if (displayText) { displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
    if (editBtn) editBtn.hidden = false;
    if (expandBtn) expandBtn.hidden = false;
    var errText = _scriptErrorText(e);
    chatAddMsg("status", '<span class="chat-status-err">生成失败: ' + escapeHtml(errText) + '</span>');
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    if (_isScriptRequestCurrent(guard)) {
      _scriptGenerating = false;
      $("btnGenScript").disabled = false;
      if (displayText) displayText.classList.remove("streaming-wave");
    }
    _finishScriptRequest(guard);
    if (chatBox) chatBox.removeEventListener("scroll", _onUserScroll);
  }
}

// ── 刷新 / 切项目时的咨询历史回放 ────────────────────────────────────
//
// 条件：当前 project 尚未确认剧本（!project.script）且 scriptConsult.messages
// 非空时，把后端存的对话一条条 replay 到聊天面板。这样即使刷新/切项目回来，
// 用户看到的还是自己上次聊到哪一步，附带"确认生成剧本"按钮仍然可点。
//
// 幂等：用 chatMessages 上的 `data-consult-version` sentinel 跟踪已回放过的
// 历史长度，避免 refreshScriptPage 被反复调用导致重复注入。
function _replayScriptConsultHistory() {
  if (!project) return;
  if (project.script) return;  // 已走到正式剧本就不再回放咨询
  var sc = project.scriptConsult || {};
  var msgs = Array.isArray(sc.messages) ? sc.messages : [];
  if (!msgs.length) {
    if (_scriptConsultGuardEnabled() && isEmptyScriptConsultState(sc)) _clearConsultDomForEmptyProject();
    return;
  }

  var box = $("chatMessages");
  if (!box) return;
  var tag = String(project.id || "") + ":" + String(msgs.length);
  if (box.dataset.consultVersion === tag) return;  // 已经回放过这版本，跳过

  // 清空聊天面板（只有还没剧本的时候才执行；有剧本时走上面的分支早退）
  var inner = box.querySelector(".max-w-2xl");
  if (inner) inner.innerHTML = "";

  var lastAiBubble = null;
  var lastAiReady = false;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i] || {};
    var role = m.role;
    var content = typeof m.content === "string" ? m.content : "";
    if (role === "user") {
      chatAddMsg("user", escapeHtml(content));
      lastAiBubble = null;
      lastAiReady = false;
    } else if (role === "ai" || role === "assistant") {
      var aiMsg = chatAddMsg("ai", "");
      var bubble = aiMsg && aiMsg.querySelector(".chat-bubble--ai");
      if (bubble) bubble.textContent = content;
      lastAiBubble = bubble;
      lastAiReady = !!m.readyToDraft;
    }
  }
  // 只给"最后一条 AI 且 ready"挂按钮——历史中间的 ready 消息就算出过，也早
  // 被后面的追问覆盖了，挂多个按钮反而迷惑。
  //
  // 兼容老数据：早期后端写库时没把 readyToDraft 落到每条消息上（只存在
  // sc.ready 模块级字段）。刷新回来如果 sc.ready=true 且尚未 confirm 过，
  // 最后一条是 AI 的，就也当 ready 处理，避免"下一步按钮消失"。
  var consultReadyFallback = !!sc.ready && !sc.confirmedAt && !project.script;
  if (lastAiBubble && (lastAiReady || consultReadyFallback)) {
    _appendConfirmDraftButton(lastAiBubble);
  }
  box.dataset.consultVersion = tag;
  _scrollChatToBottom();
}

// ── 清空咨询状态（新项目 / 重新生成时用） ──────────────────────────────
// 仅改内存 + debounce 的 saveProject；后端 run_consult_turn 下一轮落盘时会
// 重新置 startedAt = now，整轮咨询重来。
function _clearScriptConsultState(originId) {
  if (!originId) return;
  _ctx.safeWriteBack(originId, function (proj) {
    proj.scriptConsult = emptyScriptConsultState();
  });
}

function _appendSourceAdaptHint(userMsgEl, onRewind) {
  var bubble = userMsgEl && userMsgEl.querySelector(".chat-bubble--user");
  if (!bubble) return null;
  var hint = document.createElement("div");
  hint.className = "source-adapt-hint";
  hint.innerHTML = '已识别为原文，正在直接生成 · <button type="button" class="source-adapt-hint__rewind">改走咨询</button>';
  bubble.appendChild(hint);
  var btn = hint.querySelector(".source-adapt-hint__rewind");
  if (btn) {
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      btn.disabled = true;
      onRewind && onRewind(hint);
    });
  }
  return hint;
}

function _removeSourceAdaptHint(hintEl) {
  if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
}

function _cleanupScriptGenerateAbortUI(opts) {
  opts = opts || {};
  if (opts.stepEl) { opts.stepEl.hidden = true; opts.stepEl.textContent = ""; }
  if (opts.displayText) {
    opts.displayText.textContent = "";
    opts.displayText.style.pointerEvents = "";
    opts.displayText.classList.remove("streaming-wave");
  }
  if (opts.editBtn) opts.editBtn.hidden = false;
  if (opts.expandBtn) opts.expandBtn.hidden = false;
  if (opts.resultCard && opts.hideResultCard) opts.resultCard.hidden = true;
  _removeSourceAdaptHint(opts.hintEl);
}

export async function generateScript(idea, options) {
  options = options || {};
  var fromSource = !!options.fromSource;
  if (!idea) {
    idea = $("ideaInput").value.trim();
    if (!idea) { showToast("请输入创意", "warn"); return; }
  }
  if (!project) _ctx.createNewProject && _ctx.createNewProject();
  var originId = project.id;
  if (!fromSource) {
    project.idea = idea;
    project.name = idea.slice(0, 20);
  }
  // 时长解析已下沉到后端 services/script_core.parse_duration_from_idea。
  // 后端 run_full_create 里，当 body 没传 durationSec 时会自动从 idea 里嗅，
  // 嗅出来的值通过 done 事件的 resp.durationSec 回传给前端，下方 safeWriteBack
  // 里再回写 project.scriptTargetDurationSec 作为后续 revise / expand 的默认值。
  // 走 generateScript 说明用户选择了"跳过咨询直接生成"（一般是输入框发送
  // 或程序路径，而不是 handleScriptInput → _consultTurn 那条主路径）。把咨询
  // 历史清掉，避免后续 refreshScriptPage 又把旧对话回放出来。
  _clearScriptConsultState(originId);
  var chatBox0 = $("chatMessages");
  if (chatBox0) delete chatBox0.dataset.consultVersion;

  _scriptGenerating = true;
  $("btnGenScript").disabled = true;
  $("ideaInput").value = "";
  chatAutoResize($("ideaInput"));
  var userMessage = Object.prototype.hasOwnProperty.call(options, "userMessage") ? options.userMessage : idea;
  var userMsgEl = options.skipUserBubble ? null : chatAddMsg("user", escapeHtml(userMessage));

  var displayText = $("scriptDisplayText");
  var editArea = $("scriptOutput");
  var editBtn = $("btnEditScript");
  var expandBtn = $("btnExpandScript");
  var resultCard = $("scriptResultCard");
  var hideResultOnAbort = !!(fromSource && resultCard && resultCard.hidden && !(project && project.script));
  resultCard.hidden = false;
  _moveScriptResultToEnd();
  if (displayText) { displayText.textContent = ""; displayText.style.pointerEvents = "none"; displayText.classList.add("streaming-wave"); }
  if (editArea) editArea.value = "";
  if (editBtn) editBtn.hidden = true;
  if (expandBtn) expandBtn.hidden = true;
  _hideScriptConfirmArea();
  showScriptDisplay();
  _scrollChatToBottom();

  var _userScrolledUp = false;
  var chatBox = $("chatMessages");
  function _onUserScroll() {
    if (!chatBox) return;
    var atBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;
    _userScrolledUp = !atBottom;
  }
  if (chatBox) chatBox.addEventListener("scroll", _onUserScroll);

  var _scriptStepState = { buf: "" };
  var stepEl = $("scriptStreamStep");
  if (stepEl) { stepEl.hidden = true; stepEl.textContent = ""; }
  var abortController = fromSource && typeof AbortController !== "undefined" ? new AbortController() : null;
  var sourceAbortToConsult = false;
  var sourceHintEl = null;
  if (fromSource && userMsgEl && options.sourceHint !== false) {
    sourceHintEl = _appendSourceAdaptHint(userMsgEl, function () {
      sourceAbortToConsult = true;
      _removeSourceAdaptHint(sourceHintEl);
      if (abortController) abortController.abort();
    });
  }
  try {
    var requestBody = {
      projectId: project.id,
      mode: fromSource ? "adapt" : "generate",
      durationSec: project.scriptTargetDurationSec || null,
      creatorProfile: _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null,
    };
    if (fromSource) requestBody.sourceText = idea;
    else requestBody.idea = idea;
    var resp = await apiPostStream("/api/script/workflow/full-create", requestBody, null, function (evt) {
      if (evt.type === "script_chunk") {
        var raw = evt.content || "";
        var clean = consumeStreamStepTags(raw, _scriptStepState, function (hint) {
          if (stepEl) { stepEl.hidden = false; stepEl.textContent = "AI · " + hint; }
        });
        if (displayText) displayText.textContent += clean;
        if (!_userScrolledUp) _scrollChatToBottom();
      }
    }, abortController ? { signal: abortController.signal } : null);

		    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
		      proj.script = resp.script || "";
		      proj.scriptDraft = resp.script || "";
		      proj.scriptApproved = false;
		      proj.scriptReviewState = "draft";
	      proj.emotionSegments = Array.isArray(resp.emotionSegments) ? resp.emotionSegments : [];
	      proj.scriptTargetDurationSec = resp.durationSec || proj.scriptTargetDurationSec || null;
      if (fromSource && resp.oneSentenceBrief) {
        proj.idea = resp.oneSentenceBrief;
        proj.name = resp.oneSentenceBrief.slice(0, 20) || proj.name;
      }
	      proj.assets = null;
      proj.assetsApproved = false;
      proj.shots = [];
      proj.shotsApproved = false;
    });

    if (isCurrent) {
	      if (displayText) { displayText.textContent = resp.script; displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
	      if (editArea) editArea.value = resp.script;
	      refreshScriptImportDraft();
	      _syncScriptDraftMeta();
	      if (editBtn) editBtn.hidden = false;
      if (expandBtn) expandBtn.hidden = false;
      _scrollChatToBottom();
      _updateScriptInputPlaceholder();
      if (stepEl) stepEl.hidden = true;
		      chatRemoveDots();
      _showScriptConfirmArea();
      chatAddMsg("status", '<span class="chat-status-ok">剧本草稿已生成。请确认剧本后，到「风格制定」页选择画幅和模板，再生成风格圣经。</span>');
      _removeSourceAdaptHint(sourceHintEl);
		      renderEmotionSegments();
	      renderScriptAnalysis();
		    }
  } catch (e) {
    if (e && e.name === "AbortError") {
      _cleanupScriptGenerateAbortUI({
        stepEl: stepEl,
        displayText: displayText,
        editBtn: editBtn,
        expandBtn: expandBtn,
        resultCard: resultCard,
        hideResultCard: hideResultOnAbort,
        hintEl: sourceHintEl,
      });
      if (sourceAbortToConsult) {
        await _consultTurn(idea, { skipUserBubble: true });
      }
      return;
    }
    if (stepEl) stepEl.hidden = true;
    if (displayText) { displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
    if (editBtn) editBtn.hidden = false;
    if (expandBtn) expandBtn.hidden = false;
    _removeSourceAdaptHint(sourceHintEl);
    var errText = _scriptErrorText(e);
    chatAddMsg("status", '<span class="chat-status-err">生成失败: ' + escapeHtml(errText) + '</span>');
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    _scriptGenerating = false;
    $("btnGenScript").disabled = false;
    if (chatBox) chatBox.removeEventListener("scroll", _onUserScroll);
    if (displayText) displayText.classList.remove("streaming-wave");
  }
}

function _updateScriptInputPlaceholder() {
  var el = $("ideaInput");
  if (!el) return;
  var hasScript = project && project.script && project.script.trim();
  if (hasScript) {
    el.placeholder = "输入修改指令，如：让开头更紧凑、增加一段打斗、换个结局…";
    return;
  }
  // 没剧本 → 统一走咨询入口。不管是刚进来还是已经聊了几轮，提示文案都一样，
  // 强调"先聊清楚再生成"。
  var sc = (project && project.scriptConsult) || {};
  var hasHistory = Array.isArray(sc.messages) && sc.messages.length > 0;
  el.placeholder = hasHistory
    ? '继续补充你的想法，觉得聊够了就点「确认生成剧本」'
    : '聊聊你想拍什么，AI 先陪你把需求聊清楚…';
}

export async function extractStyleBible(options) {
  if (!project || !project.script) return;
  options = options || {};
  var originId = project.id;
  try {
	    var payload = {
	      projectId: project.id,
	      styleOptions: options.styleOptions || null,
	      styleTemplateSnapshot: options.styleTemplateSnapshot || project.styleTemplateSnapshot || null,
	      worldTemplateSnapshot: options.worldTemplateSnapshot || project.worldTemplateSnapshot || null,
	      selectedWorldTemplateId: project.selectedWorldTemplateId || null,
	      selectedStyleTemplateId: project.selectedStyleTemplateId || null,
	      creatorProfile: options.creatorProfile || (_ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null),
	    };
    var httpResp = await fetch("/api/script/workflow/extract-style-bible", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    var resp = await httpResp.json().catch(function () { return {}; });
    if (!httpResp.ok) {
      var err = new Error(resp.detail || resp.error || ("风格圣经生成失败：" + httpResp.status));
      err.status = httpResp.status;
      err.payload = resp;
      throw err;
    }
    if (!_isStyleBibleReadyResponse(resp)) {
      if (resp && (resp.accepted || resp.styleBibleStatus === "generating")) {
        _ctx.safeWriteBack(originId, function (proj) {
          _applyStyleBibleResponse(proj, resp);
        });
        resp = await _waitStyleBibleReady(originId, resp);
      } else {
        throw new Error(_styleBibleErrorText(resp, "未知错误"));
      }
    }
			    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
		      _applyStyleBibleResponse(proj, resp);
		      if (proj.assets) {
	        if (!proj._staleFlags) proj._staleFlags = {};
	        proj._staleFlags["assets"] = true;
	      }
			    });
			    if (isCurrent) {
			      if (_ctx.markDownstreamStale) _ctx.markDownstreamStale("style_bible", {});
			    }
			  } catch (e) {
    if (e && e.status === 409) throw e;
    var errText = _scriptErrorText(e);
    _ctx.safeWriteBack(originId, function (proj) {
      proj.styleBibleStatus = "failed";
      proj.styleBibleError = errText;
    });
    throw e;
			  }
}

export async function confirmScript() {
  if (!project) { showToast("请先生成剧本", "warn"); return; }
  var originId = project.id;
  var oldScript = project.script;
  var oldReviewState = project.scriptReviewState || "";
  var edited = ($("scriptOutput").value || "").trim();
  var finalScript = edited || project.script;
  if (!finalScript) { showToast("请先生成剧本", "warn"); return; }

  // 先把本地内存同步一下（不然切页瞬间 UI 有旧内容）。后端立刻会把
  // scriptApproved=true 和 script 持久化，narrations/emotionSegments 由后端
  // fire-and-forget 补齐，下次项目读取即生效。
  _ctx.safeWriteBack(originId, function (proj) {
    proj.script = finalScript;
    proj.scriptDraft = finalScript;
    proj.scriptApproved = true;
    proj.scriptReviewState = "approved";
    proj.currentStep = Math.max(proj.currentStep || 0, 2);
  });
  if (finalScript !== oldScript) {
    _ctx.markDownstreamStale && _ctx.markDownstreamStale("script", {});
  }
  _ctx.saveProject && _ctx.saveProject();
  refreshScriptImportDraft();
  _syncScriptDraftMeta();

  try {
    await apiPost("/api/script/workflow/confirm", {
      projectId: originId,
      script: finalScript,
    });
    if (_ctx.reloadProjectFromServer) {
      await _ctx.reloadProjectFromServer();
    }
  } catch (e) {
    // 后端拒绝（脚本空 / 项目不存在等）——回滚本地 scriptApproved
    _ctx.safeWriteBack(originId, function (proj) {
      proj.scriptApproved = false;
      proj.scriptReviewState = oldReviewState || "draft";
    });
    _ctx.saveProject && _ctx.saveProject();
    _syncScriptDraftMeta();
    showToast("确认失败: " + ((e && e.message) || e).toString().slice(0, 120), "error");
    return;
  }

  _ctx.switchPage && _ctx.switchPage("style");
}

export async function tagEmotions() {
  // 前薄后厚后：生成 / 修订 / 确认 / 扩写 / 续写等主流程自带情绪标注，
  // 老项目没情绪段时后端 GET 侧边自动补（project_api._maybe_backfill_emotions）。
  // 前端 `tagEmotions()` 仅保留给「重新分析情绪」按钮用（用户明确想重标）。
  if (!project || !project.script) return;
  var originId = project.id;
  var episodeIdx = project.currentEpisodeIdx;
  var inflightKey = originId + "_" + (episodeIdx || 0);
  if (_emotionTagInflight[inflightKey]) return;
  _emotionTagInflight[inflightKey] = true;
  try {
    var resp = await apiPost("/api/script/workflow/retag-emotions", {
      projectId: project.id,
    });
    var segments = (resp && resp.emotionSegments) || [];
    _ctx.safeWriteBack(originId, function (proj) { proj.emotionSegments = segments; });
    _ctx.saveProject();
	    renderEmotionSegments();
    renderScriptAnalysis();
	  } catch (e) {
    console.error("[EmotionTag] Tag failed:", e);
  } finally {
    delete _emotionTagInflight[inflightKey];
  }
}

var _EMOTION_DOWNSTREAM_HINT = "修改后：全项目分镜、画面描述、视频提示词会标记为需重新生成";

function _findHintInScript(fullText, hint) {
  if (!hint || !fullText) return -1;
  var raw = fullText.indexOf(hint);
  if (raw >= 0) return raw;
  var parts = [];
  for (var i = 0; i < hint.length; i++) {
    var c = hint.charAt(i);
    if (/\s/.test(c)) continue;
    parts.push(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  if (!parts.length) return -1;
  try {
    var re = new RegExp(parts.join("\\s*"));
    var m = fullText.match(re);
    return m ? m.index : -1;
  } catch (e) {
    return -1;
  }
}

export function renderEmotionSegments() {
  var ruler = $("emotionRuler");
  if (!ruler) return;
  var segs = (project && project.emotionSegments) || [];
  var scriptEl = $("scriptDisplayText");
  var retryBtn = $("btnRetagEmotions");
  var hasScript = !!(project && project.script && scriptEl && scriptEl.textContent);
  if (retryBtn) retryBtn.hidden = !(hasScript && !segs.length);
  if (!segs.length || !scriptEl || !scriptEl.textContent) { ruler.hidden = true; return; }

  ruler.hidden = false;
  ruler.innerHTML = "";
  var fullText = scriptEl.textContent || "";
  var totalLen = fullText.length;
  if (totalLen < 10) { ruler.hidden = true; return; }

  // 三级 fallback 策略（由后端 services/script_core.locate_segment_anchors 驱动）：
  //   L1: 优先用后端写好的 startChar / endChar（相对原始 script 的字符偏移，精准）
  //   L2: 后端没给就用 paragraphStart / End 在 fullText 里做空白容忍 indexOf（兼容老 project.json）
  //   L3: 再失败就等分兜底（兼容极端异常数据）
  // 所有 range 都在 fullText 原始坐标系里，totalChars = fullText.length，渲染比例统一。
  var ranges = [];
  var fullLen = fullText.length;
  var equalStep = segs.length ? Math.floor(fullLen / segs.length) : fullLen;
  segs.forEach(function (seg, segIdx) {
    var sPos = -1;
    var ePos = -1;
    if (typeof seg.startChar === "number" && seg.startChar >= 0 &&
        typeof seg.endChar === "number" && seg.endChar > seg.startChar) {
      sPos = Math.min(seg.startChar, fullLen);
      ePos = Math.min(seg.endChar, fullLen);
    } else {
      sPos = _findHintInScript(fullText, seg.paragraphStart);
      var endKey = seg.paragraphEnd || "";
      ePos = _findHintInScript(fullText, endKey);
      if (ePos >= 0) ePos += endKey.length;
      if (sPos < 0) sPos = ranges.length ? ranges[ranges.length - 1].end : segIdx * equalStep;
      if (ePos < 0) ePos = sPos + equalStep;
    }
    ranges.push({ start: sPos, end: Math.min(ePos, fullLen), seg: seg, segIdx: segIdx });
  });

  if (ranges.length && ranges[0].start > 0) ranges[0].start = 0;
  if (ranges.length) ranges[ranges.length - 1].end = fullLen;
  for (var i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) ranges[i].start = ranges[i - 1].end;
    if (ranges[i].start > ranges[i].end) ranges[i].end = ranges[i].start + 1;
  }

  var totalChars = fullLen || 1;
  requestAnimationFrame(function () {
    var containerH = scriptEl.offsetHeight;
    if (containerH < 40) containerH = 400;
    ruler.style.height = containerH + "px";
    var gap = 2;
    ranges.forEach(function (r) {
      var topPct = r.start / totalChars;
      var heightPct = Math.max(0.02, (r.end - r.start) / totalChars);
      var topPx = Math.round(topPct * containerH);
      var heightPx = Math.max(24, Math.round(heightPct * containerH) - gap);
      var seg = r.seg;
      var lv = Math.max(1, Math.min(5, seg.intensity || 3));
      var label = EMOTION_LABEL_CN[seg.emotion] || seg.emotion || "?";
      var pacingCn = PACING_LABEL_CN[seg.pacing] || "";
      var peaks = Array.isArray(seg.peakMoments) ? seg.peakMoments : [];
      var div = document.createElement("div");
      div.className = "emotion-ruler-seg emotion-ruler-seg--editable";
      div.dataset.intensity = lv;
      div.dataset.segIdx = r.segIdx;
      div.style.top = topPx + "px";
      div.style.height = heightPx + "px";
      var peakTitle = peaks.length ? ("\n关键时刻 " + peaks.length + " 处（点击段条 → 编辑）") : "";
      div.title = label + " · 强度" + lv + "/5\n" + (seg.note || "") + (pacingCn ? "\n节奏：" + pacingCn : "") + peakTitle + "\n\n点击编辑 · " + _EMOTION_DOWNSTREAM_HINT;
      var inner = '<span class="er-label">' + escapeHtml(label) + '</span><span class="er-intensity">' + lv + '</span>';
      if (heightPx > 50 && pacingCn) inner += '<span class="er-pacing">' + escapeHtml(pacingCn) + '</span>';
      inner += '<span class="er-edit-icon material-symbols-outlined">tune</span>';
      peaks.forEach(function (pm) {
        var pTop = Math.max(0, Math.min(1, Number(pm.position) || 0.5));
        var pIntensity = Math.max(1, Math.min(5, Number(pm.intensity) || 3));
        inner += '<span class="er-peak" style="top:' + (pTop * 100).toFixed(1) + '%" data-peak-intensity="' + pIntensity + '" title="关键时刻 · 强度' + pIntensity + '/5：' + escapeHtml(pm.note || '') + '"></span>';
      });
      div.innerHTML = inner;
      div.addEventListener("click", function () { _openEmotionSegEditor(r.segIdx); });
      ruler.appendChild(div);
    });
  });
}

function _openEmotionSegEditor(segIdx) {
  if (!project || !project.emotionSegments || !project.emotionSegments[segIdx]) return;
  var seg = project.emotionSegments[segIdx];
  var originId = project.id;

  var existing = document.getElementById("emotionSegEditor");
  if (existing) existing.remove();

  var overlay = document.createElement("div");
  overlay.id = "emotionSegEditor";
  overlay.className = "es-editor-overlay";
  var peaksHtml = "";
  (seg.peakMoments || []).forEach(function (pm, pi) {
    peaksHtml += '<div class="es-peak-row" data-peak-idx="' + pi + '">' +
      '<span class="es-peak-label">关键时刻 ' + (pi + 1) + '</span>' +
      '<input type="number" step="0.05" min="0" max="1" class="es-peak-pos" value="' + (Number(pm.position).toFixed(2)) + '" title="段内相对位置 0-1" />' +
      '<input type="number" min="1" max="5" class="es-peak-int" value="' + (Number(pm.intensity) || 3) + '" title="强度 1-5" />' +
      '<input type="text" class="es-peak-note" value="' + escapeHtml(pm.note || '') + '" placeholder="这一刻为什么是小高潮" />' +
      '<button type="button" class="es-peak-del" title="删除关键时刻">×</button>' +
      '</div>';
  });
  overlay.innerHTML =
    '<div class="es-editor-modal">' +
      '<div class="es-editor-header"><span class="material-symbols-outlined">tune</span>编辑情绪段 ' + (segIdx + 1) + '<button type="button" class="es-editor-close" title="关闭">×</button></div>' +
      '<p class="es-editor-hint">' + _EMOTION_DOWNSTREAM_HINT + '</p>' +
      '<div class="es-field"><label>情绪 Emotion</label>' +
        '<select class="es-emotion">' +
          Object.keys(EMOTION_LABEL_CN).map(function (k) {
            return '<option value="' + k + '"' + (seg.emotion === k ? ' selected' : '') + '>' + EMOTION_LABEL_CN[k] + ' (' + k + ')</option>';
          }).join('') +
        '</select></div>' +
      '<div class="es-field"><label>强度 Intensity <span class="es-int-val">' + (seg.intensity || 3) + '</span> / 5</label>' +
        '<input type="range" min="1" max="5" value="' + (seg.intensity || 3) + '" class="es-intensity" /></div>' +
      '<div class="es-field"><label>节奏 Pacing</label>' +
        '<select class="es-pacing">' +
          Object.keys(PACING_LABEL_CN).map(function (k) {
            return '<option value="' + k + '"' + (seg.pacing === k ? ' selected' : '') + '>' + PACING_LABEL_CN[k] + ' (' + k + ')</option>';
          }).join('') +
        '</select></div>' +
      '<div class="es-field"><label>备注 Note</label>' +
        '<textarea class="es-note" rows="2" placeholder="一句话概括这段的叙事功能">' + escapeHtml(seg.note || '') + '</textarea></div>' +
      '<div class="es-field"><label>关键时刻 Peak Moments <span class="es-field-hint">段内小高潮，解锁高情绪词库</span></label>' +
        '<div class="es-peaks">' + peaksHtml + '</div>' +
        '<button type="button" class="es-peak-add">+ 添加关键时刻</button></div>' +
      '<div class="es-editor-actions">' +
        '<button type="button" class="es-btn es-btn--cancel">取消</button>' +
        '<button type="button" class="es-btn es-btn--save">保存并标记下游</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }

  overlay.querySelector(".es-editor-close").addEventListener("click", close);
  overlay.querySelector(".es-btn--cancel").addEventListener("click", close);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

  var intSlider = overlay.querySelector(".es-intensity");
  var intVal = overlay.querySelector(".es-int-val");
  intSlider.addEventListener("input", function () { intVal.textContent = intSlider.value; });

  overlay.querySelector(".es-peak-add").addEventListener("click", function () {
    var peaksBox = overlay.querySelector(".es-peaks");
    var pi = peaksBox.querySelectorAll(".es-peak-row").length;
    var row = document.createElement("div");
    row.className = "es-peak-row";
    row.dataset.peakIdx = pi;
    row.innerHTML =
      '<span class="es-peak-label">关键时刻 ' + (pi + 1) + '</span>' +
      '<input type="number" step="0.05" min="0" max="1" class="es-peak-pos" value="0.50" title="段内相对位置 0-1" />' +
      '<input type="number" min="1" max="5" class="es-peak-int" value="' + Math.min(5, (seg.intensity || 3) + 1) + '" title="强度 1-5" />' +
      '<input type="text" class="es-peak-note" value="" placeholder="这一刻为什么是小高潮" />' +
      '<button type="button" class="es-peak-del" title="删除关键时刻">×</button>';
    peaksBox.appendChild(row);
    _bindPeakDelete(row);
  });

  function _bindPeakDelete(row) {
    row.querySelector(".es-peak-del").addEventListener("click", function () { row.remove(); });
  }
  var initialRows = overlay.querySelectorAll(".es-peak-row");
  for (var ri = 0; ri < initialRows.length; ri++) _bindPeakDelete(initialRows[ri]);

  overlay.querySelector(".es-btn--save").addEventListener("click", function () {
    var newEmotion = overlay.querySelector(".es-emotion").value;
    var newIntensity = parseInt(intSlider.value, 10);
    var newPacing = overlay.querySelector(".es-pacing").value;
    var newNote = overlay.querySelector(".es-note").value.trim();
    var newPeaks = [];
    var rows = overlay.querySelectorAll(".es-peak-row");
    for (var i = 0; i < rows.length; i++) {
      var pos = parseFloat(rows[i].querySelector(".es-peak-pos").value);
      if (isNaN(pos)) pos = 0.5;
      pos = Math.max(0, Math.min(1, pos));
      var pint = parseInt(rows[i].querySelector(".es-peak-int").value, 10);
      if (isNaN(pint)) pint = newIntensity;
      pint = Math.max(1, Math.min(5, pint));
      var pnote = rows[i].querySelector(".es-peak-note").value.trim().slice(0, 120);
      newPeaks.push({ position: pos, intensity: pint, note: pnote });
    }
    var changed = (newEmotion !== seg.emotion) || (newIntensity !== seg.intensity) || (newPacing !== seg.pacing) || (newNote !== (seg.note || "")) || JSON.stringify(newPeaks) !== JSON.stringify(seg.peakMoments || []);
    _ctx.safeWriteBack(originId, function (proj) {
      if (!proj.emotionSegments || !proj.emotionSegments[segIdx]) return;
      proj.emotionSegments[segIdx].emotion = newEmotion;
      proj.emotionSegments[segIdx].intensity = newIntensity;
      proj.emotionSegments[segIdx].pacing = newPacing;
      proj.emotionSegments[segIdx].note = newNote;
      proj.emotionSegments[segIdx].peakMoments = newPeaks;
    });
    if (changed && _ctx.markDownstreamStale) _ctx.markDownstreamStale("emotion", {});
    _ctx.saveProject && _ctx.saveProject();
	    renderEmotionSegments();
    renderScriptAnalysis();
	    close();
    if (changed) showToast("情绪段已更新；下游分镜/画面/视频提示词已标记为需重新生成", "success");
  });
}

export async function reviseScript(instruction) {
  var originId = project.id;
  _scriptGenerating = true;
  $("btnGenScript").disabled = true;
  $("ideaInput").value = "";
  chatAutoResize($("ideaInput"));
  chatAddMsg("user", escapeHtml(instruction));

  var displayText = $("scriptDisplayText");
  var editArea = $("scriptOutput");
  var editBtn = $("btnEditScript");
  var expandBtn = $("btnExpandScript");
  var _reviseCard = $("scriptResultCard");
  if (_reviseCard) _moveScriptResultToEnd();
  if (displayText) { displayText.textContent = ""; displayText.style.pointerEvents = "none"; displayText.classList.add("streaming-wave"); }
  if (editBtn) editBtn.hidden = true;
  if (expandBtn) expandBtn.hidden = true;
  _hideScriptConfirmArea();
  showScriptDisplay();

  var _userScrolledUp = false;
  var chatBox = $("chatMessages");
  function _onUserScroll() {
    if (!chatBox) return;
    var atBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;
    _userScrolledUp = !atBottom;
  }
  if (chatBox) chatBox.addEventListener("scroll", _onUserScroll);

  var _revStepState = { buf: "" };
  var stepEl2 = $("scriptStreamStep");
  if (stepEl2) { stepEl2.hidden = true; stepEl2.textContent = ""; }
  try {
    var resp = await apiPostStream("/api/script/workflow/full-create", {
      projectId: project.id,
      mode: "revise",
      script: project.script,
      instruction: instruction,
      durationSec: project.scriptTargetDurationSec || null,
      creatorProfile: _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null,
    }, null, function (evt) {
      if (evt.type === "script_chunk") {
        var raw = evt.content || "";
        var clean = consumeStreamStepTags(raw, _revStepState, function (hint) {
          if (stepEl2) { stepEl2.hidden = false; stepEl2.textContent = "AI · " + hint; }
        });
        if (displayText) displayText.textContent += clean;
        if (!_userScrolledUp) _scrollChatToBottom();
	      }
	    });

		    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
		      proj.script = resp.script || "";
		      proj.scriptDraft = resp.script || "";
		      proj.scriptApproved = false;
		      proj.scriptReviewState = "draft";
	      proj.emotionSegments = Array.isArray(resp.emotionSegments) ? resp.emotionSegments : [];
	      proj.scriptTargetDurationSec = resp.durationSec || proj.scriptTargetDurationSec || null;
	    });

    if (isCurrent) {
	      if (displayText) { displayText.textContent = resp.script; displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
	      if (editArea) editArea.value = resp.script;
	      refreshScriptImportDraft();
	      _syncScriptDraftMeta();
	      if (editBtn) editBtn.hidden = false;
      if (expandBtn) expandBtn.hidden = false;
      if (stepEl2) stepEl2.hidden = true;
      _scrollChatToBottom();
      _updateScriptInputPlaceholder();
		      chatRemoveDots();
      _showScriptConfirmArea();
      chatAddMsg("status", '<span class="chat-status-ok">新版剧本已生成，点击确认剧本后开始制定画面风格。</span>');
	      renderEmotionSegments();
	      renderScriptAnalysis();
		    }
  } catch (e) {
    if (stepEl2) stepEl2.hidden = true;
    if (displayText) { displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
    if (editBtn) editBtn.hidden = false;
    if (expandBtn) expandBtn.hidden = false;
    var errText = _scriptErrorText(e);
    chatAddMsg("status", '<span class="chat-status-err">修改失败: ' + escapeHtml(errText) + '</span>');
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    _scriptGenerating = false;
    $("btnGenScript").disabled = false;
    if (chatBox) chatBox.removeEventListener("scroll", _onUserScroll);
    if (displayText) displayText.classList.remove("streaming-wave");
  }
}
