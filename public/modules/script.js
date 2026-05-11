import { $, escapeHtml, showToast, apiPost, apiPostStream, consumeStreamStepTags, stripStepTags } from './utils.js';

var _ctx = {};
var project = null;

export function initScript(ctx) { _ctx = ctx; }
export function syncScriptProject(p) { project = p; }

var _scriptGenerating = false;
var _emotionTagInflight = {};
var _emotionAutoTried = {};

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
  if (w && w.parentNode) w.parentNode.removeChild(w);
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
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 110) + "px";
}

function _scrollChatToBottom() {
  var box = $("chatMessages");
  if (box) { setTimeout(function() { box.scrollTop = box.scrollHeight; }, 60); }
}

function _scriptMessageContainer() {
  var box = $("chatMessages");
  return box ? (box.querySelector(".max-w-2xl") || box) : null;
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

function _announceStyleBibleReady() {
  chatAddMsg("status", '<span class="chat-status-ok">初版风格已生成；请确认剧本后到「风格制定」页检查</span>');
  _showScriptConfirmArea();
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

  renderEmotionSegments();

  var ideaInput = $("ideaInput");
  if (ideaInput && project && !project.script) ideaInput.value = project.idea || "";
  _updateScriptInputPlaceholder();
  refreshScriptImportDraft();
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
    return;
  }
  card.hidden = false;
  if (textarea.value !== draft) textarea.value = draft;
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
  await _setImportedDraft(text);
  var scriptOutput = $("scriptOutput");
  if (scriptOutput) scriptOutput.value = text;
  var resultCard = $("scriptResultCard");
  if (resultCard) resultCard.hidden = false;
  var displayText = $("scriptDisplayText");
  if (displayText) displayText.textContent = text;
  await confirmScript();
}

function _discardImportedDraft() {
  if (!project || !project.id) return;
  var originId = project.id;
  _ctx.safeWriteBack(originId, function (proj) {
    proj.scriptDraft = proj.script || "";
  });
  _ctx.saveProject && _ctx.saveProject();
  refreshScriptImportDraft();
  showToast("已放弃导入草稿", "info");
}

var _scriptImportEventsBound = false;
export function initScriptImportEvents() {
  if (_scriptImportEventsBound) return;
  _scriptImportEventsBound = true;
  var newBtn = $("btnNewScript");
  if (newBtn) newBtn.addEventListener("click", function () { startNewScript(); });
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
    });
  }
  var applyBtn = $("btnApplyImportedDraft");
  if (applyBtn) applyBtn.addEventListener("click", function () { _applyImportedDraft(); });
  var discardBtn = $("btnDiscardImportedDraft");
  if (discardBtn) discardBtn.addEventListener("click", _discardImportedDraft);
}

export function showScriptDisplay() {
  var d = $("scriptDisplayText");
  var t = $("scriptOutput");
  if (d) d.classList.remove("hidden");
  if (t) t.classList.add("hidden");
}

export function showScriptEdit() {
  if (_scriptGenerating) return;
  var d = $("scriptDisplayText");
  var t = $("scriptOutput");
  if (d) d.classList.add("hidden");
  if (t) { t.classList.remove("hidden"); t.focus(); }
}

var _SB_DOWNSTREAM_HINT = "修改后：画面描述、分镜参考图、视频提示词会标记为待重新生成（镜头结构本身保留）";

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
  var keys = ["visualStyle", "visualStyleDesc", "era", "mood", "cameraStyle", "worldRules"];
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

function _applyStyleBibleResponse(proj, resp) {
  var ready = _isStyleBibleReadyResponse(resp);
  proj.styleBible = ready ? resp.styleBible : null;
  proj.styleBibleStatus = ready ? "ready" : "failed";
  proj.styleBibleError = ready ? "" : _styleBibleErrorText(resp);
  proj.styleBibleGeneratedAt = ready ? (resp.styleBibleGeneratedAt || new Date().toISOString()) : ((resp && resp.styleBibleGeneratedAt) || null);
  if (ready && proj._staleFlags) delete proj._staleFlags["style_bible"];
  return ready;
}

function renderStyleBibleFailure(message) {
  renderStyleBibleEmpty("风格圣经暂不可用", message || "风格圣经尚未提取或提取失败", true);
}

function renderStyleBibleEmpty(title, message, allowRetry) {
  var el = $("styleBiblePreview");
  if (!el) return;
  var heading = escapeHtml(title || "风格圣经暂不可用");
  var detail = escapeHtml(message || "生成剧本后将自动整理风格信息");
  el.innerHTML =
    '<div class="script-style-empty">' +
    '<span class="material-symbols-outlined">auto_stories</span>' +
    '<h3>' + heading + '</h3>' +
    '<p>' + detail + '</p>' +
    '</div>';
}

function _sbEditHtml(fieldKey, label, value, extra) {
  var extraClass = extra || "";
  var placeholder = value ? "" : " <span class=\"sb-edit-placeholder\">（点击编辑）</span>";
  return '<div class="sb-editable ' + extraClass + '" data-sb-field="' + fieldKey + '" data-sb-label="' + escapeHtml(label) + '" title="' + escapeHtml(_SB_DOWNSTREAM_HINT) + '">' +
    (value ? escapeHtml(value) : '') +
    placeholder +
    '<span class="sb-edit-icon material-symbols-outlined">edit</span>' +
    '</div>';
}

function _sbModuleHead(icon, title, en, editable) {
  return '<div class="script-style-module-head">' +
    '<div class="script-style-module-title">' +
      '<span class="material-symbols-outlined">' + icon + '</span>' +
      '<span class="script-style-title-cn">' + title + '</span>' +
      '<span class="script-style-title-en">' + en + '</span>' +
    '</div>' +
    (editable ? '<span class="script-style-edit-chip">可编辑</span>' : '') +
  '</div>';
}

function _sbShort(text, fallback, maxLen) {
  var s = String(text || fallback || "").trim();
  if (!s) return "";
  maxLen = maxLen || 48;
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

function _sbCharacterDesc(c) {
  if (!c) return "";
  return _sbShort(c.desc || c.description || c.role || c.appearance || c.clothing || "", "角色设定待完善", 42);
}

function _sbAvatarHtml(c) {
  var src = c && (c.avatarUrl || c.imageUrl || c.referenceImageUrl || c.url || c.src);
  var name = String((c && c.name) || "角").trim() || "角";
  if (src) {
    return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(name) + '" />';
  }
  return escapeHtml(name.charAt(0));
}

export function renderStyleBible(sb) {
  var el = $("styleBiblePreview");
  if (!el || !sb) return;
  if (!hasUsableStyleBible(sb, project)) {
    renderStyleBibleFailure(_styleBibleErrorText(project, "风格圣经尚未提取或提取失败"));
    return;
  }
  var html = '';

  if (_ctx.isStale && _ctx.isStale("style_bible")) {
    html += '<div class="upstream-stale-banner"><span class="material-symbols-outlined">warning</span>剧本已修改，风格圣经可能与剧本不一致，建议重新提取</div>';
  }

  html += '<div class="sb-section script-style-card">' +
    _sbModuleHead('visibility', '视觉风格', 'VISUAL STYLE', true) +
    _sbEditHtml('visualStyle', '视觉风格', sb.visualStyle || '', 'script-style-main') +
    _sbEditHtml('visualStyleDesc', '视觉风格描述', sb.visualStyleDesc || '', 'script-style-desc sb-editable-sm') +
    '</div>';

  html += '<div class="sb-section script-style-card">' +
    _sbModuleHead('palette', '色彩调板', 'COLOR PALETTE', true);
  if (Array.isArray(sb.colorPalette) && sb.colorPalette.length) {
    html += '<div class="script-color-swatches">';
    sb.colorPalette.slice(0, 5).forEach(function (c) {
      var hex = (c && c.hex) || '#CFD8DC';
      var name = (c && c.name) || hex;
      html += '<div class="script-color-item"><div class="script-color-block" style="background:' + escapeHtml(hex) + '"></div><span class="script-color-name">' + escapeHtml(name) + '</span></div>';
    });
    html += '</div>';
  } else {
    html += '<p class="script-style-muted">' + escapeHtml(String(sb.colorPalette || '色彩调板待补充')) + '</p>';
  }
  html += '</div>';

  html += '<div class="sb-section script-style-card">' +
    _sbModuleHead('routine', '时代与氛围', 'ERA & ATMOSPHERE', true) +
    _sbEditHtml('era', '时代与氛围', sb.era || '', 'script-style-desc') +
    '</div>';

  html += '<div class="sb-section script-style-card">' +
    _sbModuleHead('water_drop', '情绪基调', 'MOOD', true) +
    _sbEditHtml('mood', '情绪基调', sb.mood || '', 'script-style-desc') +
    '</div>';

  html += '<div class="sb-section script-style-card">' +
    _sbModuleHead('groups', '主要角色', 'CHARACTERS', true);
  if (Array.isArray(sb.characters) && sb.characters.length) {
    html += '<div class="script-characters">';
    sb.characters.slice(0, 5).forEach(function (c) {
      var name = _sbShort(c && c.name, "未命名", 10);
      html += '<div class="script-character">' +
        '<div class="script-character-avatar">' + _sbAvatarHtml(c) + '</div>' +
        '<div class="script-character-name">' + escapeHtml(name) + '</div>' +
        '<div class="script-character-desc">' + escapeHtml(_sbCharacterDesc(c)) + '</div>' +
      '</div>';
    });
    html += '</div>';
  } else {
    html += '<p class="script-style-muted">主要角色待补充</p>';
  }
  html += '</div>';

  el.innerHTML = html;
  var sections = el.querySelectorAll(".sb-section");
  for (var si = 0; si < sections.length; si++) {
    sections[si].style.animationDelay = (si * 0.09 + 0.15) + "s";
  }

  _bindStyleBibleEditors(el);
}

function _bindStyleBibleEditors(el) {
  var editables = el.querySelectorAll(".sb-editable");
  for (var i = 0; i < editables.length; i++) {
    editables[i].addEventListener("click", _onStyleBibleFieldClick);
  }
}

function _onStyleBibleFieldClick(e) {
  if (!project || !hasUsableStyleBible(project.styleBible, project)) return;
  if (e.currentTarget.classList.contains("sb-editing")) return;
  var field = e.currentTarget.getAttribute("data-sb-field");
  var label = e.currentTarget.getAttribute("data-sb-label") || field;
  var current = project.styleBible[field] || "";
  var next = window.prompt("编辑「" + label + "」\n\n" + _SB_DOWNSTREAM_HINT, current);
  if (next === null) return;
  next = next.trim();
  if (next === current) return;
  var originId = project.id;
  _ctx.safeWriteBack(originId, function (proj) {
    if (!proj.styleBible) proj.styleBible = {};
    proj.styleBible[field] = next;
  });
  if (_ctx.markDownstreamStale) _ctx.markDownstreamStale("style_bible", {});
  _ctx.saveProject && _ctx.saveProject();
  renderStyleBible(project.styleBible);
  showToast("已保存「" + label + "」；下游画面/视频提示词已标记为需重新生成", "success");
}

export async function handleScriptInput() {
  if (_scriptGenerating) return;
  var idea = $("ideaInput").value.trim();
  if (!idea) { showToast("请输入内容", "warn"); return; }
  if (!project) _ctx.createNewProject && _ctx.createNewProject();

  var hasScript = project && project.script && project.script.trim();
  if (hasScript) {
    // 已有剧本 → 走改本
    await reviseScript(idea);
  } else {
    // 还没剧本 → 多轮咨询（后端 run_consult_turn 判断信息够不够，够就给大纲 + ready）
    await _consultTurn(idea);
  }
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
async function _consultTurn(userMsg) {
  var originId = project ? project.id : null;
  if (!originId) return;
  _scriptGenerating = true;
  $("btnGenScript").disabled = true;
  $("ideaInput").value = "";
  chatAutoResize($("ideaInput"));
  chatAddMsg("user", escapeHtml(userMsg));

  var aiMsg = chatAddMsg("ai", "");
  var bubble = aiMsg && aiMsg.querySelector(".chat-bubble--ai");

  try {
    var resp = await apiPostStream("/api/script/workflow/consult/turn", {
      projectId: originId,
      message: userMsg,
      creatorProfile: _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null,
    }, null, function (evt) {
      if (evt.type === "ai_chunk") {
        if (bubble) bubble.textContent += evt.content || "";
        _scrollChatToBottom();
      }
    });

    // done 时 bubble 文本就是流式累加后的纯文本；后端已在 done payload 里
    // 给出剥干净 ready 标记的 aiMessage，用它做权威显示，避免前端自己再截标记。
    if (bubble && resp.aiMessage) bubble.textContent = resp.aiMessage;

    if (resp.readyToDraft && bubble) {
      // AI 给了大纲 + ready → 在气泡末尾挂"确认生成剧本 →"按钮
      _appendConfirmDraftButton(bubble);
    }
  } catch (e) {
    var errText = ((e && e.message) || e).toString().slice(0, 150);
    if (bubble) bubble.textContent = "";
    chatAddMsg("status", '<span class="chat-status-err">咨询失败: ' + escapeHtml(errText) + '</span>');
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    _scriptGenerating = false;
    $("btnGenScript").disabled = false;
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
// 调后端 `/api/script/workflow/consult/confirm` SSE。这个端点的事件流
// **完全复用**现有 `run_full_create` 的契约（phase / script_chunk /
// style_bible_chunk / done{script,styleBible,emotionSegments}），所以前端
// 消费代码和 `generateScript` 的 SSE 部分一字不差。
async function _consultConfirm() {
  if (!project) return;
  var originId = project.id;

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
  var _gotBibleStart = false;

  try {
    var resp = await apiPostStream("/api/script/workflow/consult/confirm", {
      projectId: originId,
      durationSec: (project && project.scriptTargetDurationSec) || null,
      creatorProfile: _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null,
    }, null, function (evt) {
      if (evt.type === "script_chunk") {
        var raw = evt.content || "";
        var clean = consumeStreamStepTags(raw, _stepState, function (hint) {
          if (stepEl) { stepEl.hidden = false; stepEl.textContent = "AI · " + hint; }
        });
        if (displayText) displayText.textContent += clean;
        if (!_userScrolledUp) _scrollChatToBottom();
      } else if (evt.type === "phase" && evt.name === "style_bible_start" && !_gotBibleStart) {
        _gotBibleStart = true;
        var _approxChars = (displayText && displayText.textContent.length) || 0;
        showToast("剧本草稿已生成（约 " + _approxChars + " 字），正在分析风格…", "info");
        chatAddMsg("status", "正在提取风格圣经…");
        chatShowDots();
      }
    });

    var styleBibleReady = _isStyleBibleReadyResponse(resp);
	    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
	      proj.script = resp.script || "";
	      proj.scriptDraft = resp.script || "";
	      proj.scriptApproved = false;
      _applyStyleBibleResponse(proj, resp);
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
	      if (editBtn) editBtn.hidden = false;
      if (expandBtn) expandBtn.hidden = false;
      _scrollChatToBottom();
      _updateScriptInputPlaceholder();
      if (stepEl) stepEl.hidden = true;
	      chatRemoveDots();
	      if (styleBibleReady) {
	        _announceStyleBibleReady();
	      } else {
	        var bibleErr = _styleBibleErrorText(resp);
	        _showScriptConfirmArea();
	        chatAddMsg("status", '<span class="chat-status-err">风格提取失败: ' + escapeHtml(bibleErr) + '，请确认剧本后到「风格制定」页重试</span>');
	      }
      renderEmotionSegments();
    }
  } catch (e) {
    if (stepEl) stepEl.hidden = true;
    if (displayText) { displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
    if (editBtn) editBtn.hidden = false;
    if (expandBtn) expandBtn.hidden = false;
    var errText = ((e && e.message) || e).toString().slice(0, 150);
    chatAddMsg("status", '<span class="chat-status-err">生成失败: ' + escapeHtml(errText) + '</span>');
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    _scriptGenerating = false;
    $("btnGenScript").disabled = false;
    if (chatBox) chatBox.removeEventListener("scroll", _onUserScroll);
    if (displayText) displayText.classList.remove("streaming-wave");
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
  if (!msgs.length) return;

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
    proj.scriptConsult = { messages: [], startedAt: null, confirmedAt: null };
  });
}

export async function generateScript(idea) {
  if (!idea) {
    idea = $("ideaInput").value.trim();
    if (!idea) { showToast("请输入创意", "warn"); return; }
  }
  if (!project) _ctx.createNewProject && _ctx.createNewProject();
  var originId = project.id;
  project.idea = idea;
  project.name = idea.slice(0, 20);
  // 时长解析已下沉到后端 services/script_core.parse_duration_from_idea。
  // 后端 run_full_create 里，当 body 没传 durationSec 时会自动从 idea 里嗅，
  // 嗅出来的值通过 done 事件的 resp.durationSec 回传给前端，下方 safeWriteBack
  // 里再回写 project.scriptTargetDurationSec 作为后续 revise / expand 的默认值。
  // 走 generateScript 说明用户选择了"跳过咨询直接生成"（一般是 btnRegenScript
  // 或程序路径，而不是 handleScriptInput → _consultTurn 那条主路径）。把咨询
  // 历史清掉，避免后续 refreshScriptPage 又把旧对话回放出来。
  _clearScriptConsultState(originId);
  var chatBox0 = $("chatMessages");
  if (chatBox0) delete chatBox0.dataset.consultVersion;

  _scriptGenerating = true;
  $("btnGenScript").disabled = true;
  $("ideaInput").value = "";
  chatAutoResize($("ideaInput"));
  chatAddMsg("user", escapeHtml(idea));

  var displayText = $("scriptDisplayText");
  var editArea = $("scriptOutput");
  var editBtn = $("btnEditScript");
  var expandBtn = $("btnExpandScript");
  var resultCard = $("scriptResultCard");
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
  var _gotBibleStart = false;
  try {
    var resp = await apiPostStream("/api/script/workflow/full-create", {
      projectId: project.id,
      mode: "generate",
      idea: idea,
      durationSec: project.scriptTargetDurationSec || null,
      creatorProfile: _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null,
    }, null, function (evt) {
      if (evt.type === "script_chunk") {
        var raw = evt.content || "";
        var clean = consumeStreamStepTags(raw, _scriptStepState, function (hint) {
          if (stepEl) { stepEl.hidden = false; stepEl.textContent = "AI · " + hint; }
        });
        if (displayText) displayText.textContent += clean;
        if (!_userScrolledUp) _scrollChatToBottom();
      } else if (evt.type === "phase" && evt.name === "style_bible_start" && !_gotBibleStart) {
        _gotBibleStart = true;
        var _approxChars = (displayText && displayText.textContent.length) || 0;
        showToast("剧本草稿已生成（约 " + _approxChars + " 字），正在分析风格…", "info");
        chatAddMsg("status", "正在提取风格圣经…");
        chatShowDots();
      }
    });

    var styleBibleReady = _isStyleBibleReadyResponse(resp);
	    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
	      proj.script = resp.script || "";
	      proj.scriptDraft = resp.script || "";
	      proj.scriptApproved = false;
      _applyStyleBibleResponse(proj, resp);
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
	      if (editBtn) editBtn.hidden = false;
      if (expandBtn) expandBtn.hidden = false;
      _scrollChatToBottom();
      _updateScriptInputPlaceholder();
      if (stepEl) stepEl.hidden = true;
	      chatRemoveDots();
	      if (styleBibleReady) {
	        _announceStyleBibleReady();
	      } else {
	        var bibleErr = _styleBibleErrorText(resp);
	        _showScriptConfirmArea();
	        chatAddMsg("status", '<span class="chat-status-err">风格提取失败: ' + escapeHtml(bibleErr) + '，请确认剧本后到「风格制定」页重试</span>');
	      }
      renderEmotionSegments();
    }
  } catch (e) {
    if (stepEl) stepEl.hidden = true;
    if (displayText) { displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
    if (editBtn) editBtn.hidden = false;
    if (expandBtn) expandBtn.hidden = false;
    var errText = ((e && e.message) || e).toString().slice(0, 150);
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

export function startNewScript() {
  if (_scriptGenerating) return;
	  _ctx.safeWriteBack(project ? project.id : null, function (proj) {
	    proj.script = "";
	    proj.scriptDraft = "";
	    proj.scriptApproved = false;
    proj.styleBible = null;
    proj.styleBibleStatus = "";
    proj.styleBibleError = "";
    proj.styleBibleGeneratedAt = null;
    proj.assets = null;
    proj.assetsApproved = false;
    proj.shots = [];
    proj.shotsApproved = false;
    proj.idea = "";
    // 新一轮创作 → 咨询历史也清掉，避免下一轮看到上次的对话
    proj.scriptConsult = { messages: [], startedAt: null, confirmedAt: null };
  });
  var chatBox = $("chatMessages");
  if (chatBox) {
    var innerWrap = chatBox.querySelector(".max-w-2xl") || chatBox;
    var msgs = innerWrap.querySelectorAll(".chat-msg:not(#scriptResultCard)");
    msgs.forEach(function (m) { m.parentNode.removeChild(m); });
    // 清 sentinel，下次 refreshScriptPage 会重新走回放判定
    delete chatBox.dataset.consultVersion;
  }
  refreshScriptPage();
  showToast("已新建空白剧本，开始你的创作", "success");
}

export async function extractStyleBible() {
  if (!project || !project.script) return;
  var originId = project.id;
  try {
    var resp = await apiPost("/api/script/workflow/extract-style-bible", {
      projectId: project.id,
      script: project.script,
    });
    if (!_isStyleBibleReadyResponse(resp)) throw new Error(_styleBibleErrorText(resp, "未知错误"));
    chatRemoveDots();
	    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
	      _applyStyleBibleResponse(proj, resp);
	      if (proj.assets) {
	        if (!proj._staleFlags) proj._staleFlags = {};
	        proj._staleFlags["assets"] = true;
	      }
		    });
		    if (isCurrent) {
		      if (_ctx.markDownstreamStale) _ctx.markDownstreamStale("style_bible", {});
		      chatAddMsg("status", '<span class="chat-status-ok">风格已重新提取，请到「风格制定」页检查</span>');
		      _showScriptConfirmArea();
		    }
	  } catch (e) {
    chatRemoveDots();
    var errText = ((e && e.message) || e).toString().slice(0, 150);
    _ctx.safeWriteBack(originId, function (proj) {
      proj.styleBibleStatus = "failed";
      proj.styleBibleError = errText;
    });
	    _showScriptConfirmArea();
	    chatAddMsg("status", '<span class="chat-status-err">风格提取失败: ' + escapeHtml(errText) + '，请到「风格制定」页重试</span>');
	  }
}

export function formatStyleBibleForChat(sb) {
  if (!hasUsableStyleBible(sb)) return "风格圣经提取失败，请点击重新生成";
  var lines = ["✦ 风格圣经已提取"];
  if (sb.visualStyle) lines.push("视觉风格: " + sb.visualStyle);
  if (sb.colorPalette) {
    if (Array.isArray(sb.colorPalette)) {
      lines.push("色调: " + sb.colorPalette.map(function (c) { return c.name; }).join(" · "));
    } else {
      lines.push("色调: " + sb.colorPalette);
    }
  }
  if (sb.era) lines.push("时代/背景: " + sb.era);
  if (sb.mood) lines.push("情绪氛围: " + sb.mood);
  if (sb.characters && sb.characters.length) {
    lines.push("角色: " + sb.characters.map(function (c) { return c.name; }).join("、"));
  }
  lines.push("\n详细信息请前往「风格制定」页查看。");
  return lines.join("\n");
}

export async function confirmScript() {
  if (!project) { showToast("请先生成剧本", "warn"); return; }
  var originId = project.id;
  var oldScript = project.script;
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
    proj.currentStep = Math.max(proj.currentStep || 0, 2);
  });
  if (finalScript !== oldScript) {
    _ctx.markDownstreamStale && _ctx.markDownstreamStale("script", {});
  }
  _ctx.saveProject && _ctx.saveProject();
  refreshScriptImportDraft();

  try {
    await apiPost("/api/script/workflow/confirm", {
      projectId: originId,
      script: finalScript,
    });
  } catch (e) {
    // 后端拒绝（脚本空 / 项目不存在等）——回滚本地 scriptApproved
    _ctx.safeWriteBack(originId, function (proj) { proj.scriptApproved = false; });
    _ctx.saveProject && _ctx.saveProject();
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
  var _gotBibleStart2 = false;
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
      } else if (evt.type === "phase" && evt.name === "style_bible_start" && !_gotBibleStart2) {
        _gotBibleStart2 = true;
        showToast("剧本已修改，正在重新提取风格圣经…", "info");
        chatAddMsg("status", "正在重新提取风格圣经…");
        chatShowDots();
      }
    });

    var styleBibleReady = _isStyleBibleReadyResponse(resp);
	    var isCurrent = _ctx.safeWriteBack(originId, function (proj) {
	      proj.script = resp.script || "";
	      proj.scriptDraft = resp.script || "";
	      proj.scriptApproved = false;
      _applyStyleBibleResponse(proj, resp);
      proj.emotionSegments = Array.isArray(resp.emotionSegments) ? resp.emotionSegments : [];
      proj.scriptTargetDurationSec = resp.durationSec || proj.scriptTargetDurationSec || null;
    });

    if (isCurrent) {
	      if (displayText) { displayText.textContent = resp.script; displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
	      if (editArea) editArea.value = resp.script;
	      refreshScriptImportDraft();
	      if (editBtn) editBtn.hidden = false;
      if (expandBtn) expandBtn.hidden = false;
      if (stepEl2) stepEl2.hidden = true;
      _scrollChatToBottom();
      _updateScriptInputPlaceholder();
	      chatRemoveDots();
	      if (styleBibleReady) {
	        chatAddMsg("status", '<span class="chat-status-ok">新版剧本已生成，初版风格已更新；请确认剧本后到「风格制定」页检查</span>');
	        _showScriptConfirmArea();
	      } else {
	        var bibleErr = _styleBibleErrorText(resp);
	        _hideScriptConfirmArea();
	        chatAddMsg("status", '<span class="chat-status-err">风格提取失败: ' + escapeHtml(bibleErr) + '，请到「风格制定」页重新提取</span>');
	      }
      renderEmotionSegments();
    }
  } catch (e) {
    if (stepEl2) stepEl2.hidden = true;
    if (displayText) { displayText.style.pointerEvents = ""; displayText.classList.remove("streaming-wave"); }
    if (editBtn) editBtn.hidden = false;
    if (expandBtn) expandBtn.hidden = false;
    var errText = ((e && e.message) || e).toString().slice(0, 150);
    chatAddMsg("status", '<span class="chat-status-err">修改失败: ' + escapeHtml(errText) + '</span>');
    _ctx.toastErrorWithActions && _ctx.toastErrorWithActions(errText);
  } finally {
    _scriptGenerating = false;
    $("btnGenScript").disabled = false;
    if (chatBox) chatBox.removeEventListener("scroll", _onUserScroll);
    if (displayText) displayText.classList.remove("streaming-wave");
  }
}
