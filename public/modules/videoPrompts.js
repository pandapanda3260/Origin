import { $, escapeHtml, showToast, showConfirm, apiPost, apiGet, apiPostStream, consumeStreamStepTags } from './utils.js';
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

function saveProject() { if (_ctx.saveProject) return _ctx.saveProject(); }
function _safeWriteBack(originId, fn, serverVersion) { return _ctx.safeWriteBack ? _ctx.safeWriteBack(originId, fn, serverVersion) : false; }
function getStoryboardGroups() { return _ctx.getStoryboardGroups ? _ctx.getStoryboardGroups() : []; }
function _isStale(key) { return _ctx.isStale ? _ctx.isStale(key) : false; }
function _clearStale(key) { if (_ctx.clearStale) _ctx.clearStale(key); }
function _checkAndSuggest(stage) { if (_ctx.checkAndSuggest) _ctx.checkAndSuggest(stage); }
function switchPage(page) { if (_ctx.switchPage) _ctx.switchPage(page); }
function formatCreatorProfileForApi() { return _ctx.formatCreatorProfileForApi ? _ctx.formatCreatorProfileForApi() : null; }
function _diagnoseApiError(msg) { return _ctx.diagnoseApiError ? _ctx.diagnoseApiError(msg) : msg; }

export function getVpSelectedGroup() { return _vpSelectedGroup; }
export function setVpSelectedGroup(idx) { _vpSelectedGroup = idx; }

/* ================================================================
   VP Cache
   ================================================================ */
export function vpCacheValid(cache, text) {
  return !!(cache && cache.version === _VP_CACHE_VERSION && cache.text === text);
}

export function vpGetCache(sb) {
  if (!sb) return _VP_EMPTY_CACHE;
  var text = sb.videoPrompt || '';
  if (vpCacheValid(sb._vpCache, text)) return sb._vpCache;
  return _VP_EMPTY_CACHE;
}

export async function vpFetchAndCache(sb) {
  if (!sb) return _VP_EMPTY_CACHE;
  var text = sb.videoPrompt || '';
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
  var text = sb.videoPrompt || '';
  if (vpCacheValid(sb._vpCache, text)) return sb._vpCache;
  var key = sb._vpKey || (sb._vpKey = 'vp_' + Math.random().toString(36).slice(2, 10));
  if (!_vpInflight[key]) {
    _vpInflight[key] = vpFetchAndCache(sb)
      .then(function (cache) { delete _vpInflight[key]; if (typeof onReady === 'function') onReady(cache); return cache; })
      .catch(function (err) { delete _vpInflight[key]; throw err; });
  } else if (typeof onReady === 'function') {
    _vpInflight[key].then(onReady);
  }
  return sb._vpCache || _VP_EMPTY_CACHE;
}

async function _vpRebuildFromSegments(segments) {
  try {
    var resp = await apiPost('/api/prompt/rebuild', { segments: segments });
    return (resp.text || '').trim();
  } catch (e) {
    console.warn('[VpRebuild] failed, using local fallback:', e);
    return (segments || []).map(function (s) {
      if (!s.time) return s.text || '';
      return '(' + s.time + ') ' + (s.text || '');
    }).join('\n');
  }
}

/* ================================================================
   Highlight / render helpers
   ================================================================ */
function _highlightLargePrompt(text, highlights, sensitiveHits) {
  if (!text) return '';
  var src = text.replace(/<[^>]*>/g, '');
  var ranges = (highlights || []).slice().sort(function (a, b) { return a.start - b.start; });
  var parts = [];
  var cursor = 0;
  ranges.forEach(function (r) {
    if (!r || r.start < cursor || r.end <= r.start || r.end > src.length) return;
    if (r.start > cursor) parts.push({ text: src.slice(cursor, r.start), kind: null });
    parts.push({ text: src.slice(r.start, r.end), kind: r.kind });
    cursor = r.end;
  });
  if (cursor < src.length) parts.push({ text: src.slice(cursor), kind: null });

  var html = parts.map(function (p) {
    var esc = escapeHtml(p.text);
    if (!p.kind) return esc;
    var cls = _HL_CLASS[p.kind];
    if (!cls) return esc;
    if (p.kind === 'bracket') {
      var inner = esc.replace(/^\[|\]$/g, '');
      return '<span class="' + cls + '">' + inner + '</span>';
    }
    return '<span class="' + cls + '">' + esc + '</span>';
  }).join('');

  if (sensitiveHits && sensitiveHits.length) {
    var seen = {};
    var senWords = [];
    sensitiveHits.forEach(function (h) {
      if (!h || !h.word || seen[h.word]) return;
      seen[h.word] = true;
      senWords.push(h.word);
    });
    senWords.sort(function (a, b) { return b.length - a.length; });
    if (senWords.length) {
      var escRe = function (s) { return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); };
      var senRe = new RegExp('(' + senWords.map(escRe).join('|') + ')', 'g');
      var pieces = html.split(/(<[^>]*>)/);
      html = pieces.map(function (piece) {
        if (!piece || piece.charAt(0) === '<') return piece;
        return piece.replace(senRe, '<span class="vp-sensitive-word bg-error/15 text-error border-b-2 border-error/40 px-0.5 rounded-sm cursor-help" title="可能触发视频API审核">$1</span>');
      }).join('');
    }
  }
  return html;
}

function _makeSegmentEditable(pEl, gIdx, segIdx, segments) {
  if (pEl.dataset.editing === "1") return;
  pEl.dataset.editing = "1";
  var rawText = segments[segIdx].text;
  pEl.textContent = rawText;
  pEl.contentEditable = "true";
  // 进编辑态：保持和展示态同字号（text-base / font-normal），只追加焦点环和编辑底色
  pEl.classList.add("outline-none", "ring-2", "ring-primary/30", "rounded-lg", "p-3", "bg-white/60", "whitespace-pre-wrap");
  pEl.focus();
  var range = document.createRange();
  range.selectNodeContents(pEl);
  range.collapse(false);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  async function save() {
    pEl.removeEventListener("blur", save);
    pEl.removeEventListener("keydown", onKey);
    var newText = pEl.textContent.trim();
    if (newText && newText !== rawText) {
      segments[segIdx].text = newText;
      var fullPrompt = await _vpRebuildFromSegments(segments);
      _syncRefs();
      if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
      project.storyboards[gIdx].videoPrompt = fullPrompt;
      if (project.storyboards[gIdx]._vpCache) project.storyboards[gIdx]._vpCache = null;
      saveProject();
      showToast("提示词已更新", "ok");
    }
    pEl.dataset.editing = "0";
    pEl.contentEditable = "false";
    pEl.classList.remove("outline-none", "ring-2", "ring-primary/30", "rounded-lg", "p-3", "bg-white/60", "whitespace-pre-wrap");
    renderVideoPromptList();
  }

  function onKey(ev) {
    if (ev.key === "Escape") { pEl.textContent = rawText; pEl.blur(); }
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) pEl.blur();
  }
  pEl.addEventListener("blur", save);
  pEl.addEventListener("keydown", onKey);
}

/* ================================================================
   Page render
   ================================================================ */
export function refreshPromptsPage() {
  _syncRefs();
  var needImages = $("promptsNeedImages");
  var ready = $("promptsReady");
  if (!project || !project.imagesApproved || !project.shots || !project.shots.length) {
    if (needImages) needImages.hidden = false;
    if (ready) ready.hidden = true;
    var vf = $("vpStoryboardFrames"); if (vf) vf.innerHTML = "";
    var vl = $("videoPromptList"); if (vl) vl.innerHTML = "";
    return;
  }
  needImages.hidden = true;
  ready.hidden = false;
  _vpSelectedGroup = Math.min(_vpSelectedGroup, Math.max(0, getStoryboardGroups().length - 1));
  _renderVpStoryboardFrames();
  renderVideoPromptList();
  checkVideoPromptsConfirm();
}

// Seedance 只出 5s / 10s 两档；后端 batch-executors.ts 按本组台词字数挑：
// ≤18 字 → 5s，>18 字 → 10s。前端展示时用完全相同的规则算出"实际成片时长"，
// 这样左边片段条上的 `0:00-0:09` 和右边视频提示词里的 `0-5s / 0-10s` 永远对齐。
function _seedanceGroupDuration(group) {
  var QUOTED_RE = /[「『""''"'‘’“”]([\s\S]*?)[」』""''"'‘’“”]/g;
  var PUNCT_RE = /[\s，。！？、…—·,.!?"'()（）「」『』"'‘’“”]/g;
  var total = 0;
  (group.shots || []).forEach(function (sh) {
    var raw = String((sh && sh.dialogue) || '').trim();
    if (!raw || raw === '——' || raw === '-' || raw === '无') return;
    raw.split(/\r?\n/).forEach(function (line) {
      var stripped = line.replace(/^\s*[^：:\n]{1,20}[：:]\s*/, '');
      var quoted = stripped.match(QUOTED_RE);
      if (quoted && quoted.length) {
        quoted.forEach(function (q) { total += q.replace(PUNCT_RE, '').length; });
      } else {
        total += stripped.replace(PUNCT_RE, '').length;
      }
    });
  });
  return total > 18 ? 10 : 5;
}

function _renderVpStoryboardFrames() {
  var container = $("vpStoryboardFrames");
  if (!container) return;
  container.innerHTML = "";
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var tag = $("vpVersionTag");
  if (tag) tag.textContent = groups.length + " 片段";

  groups.forEach(function (group, gIdx) {
    var sb = project.storyboards[gIdx] || {};
    var imgSrc = sb.rawUrl || sb.imageUrl || "";
    var isActive = gIdx === _vpSelectedGroup;
    var hasDone = !!sb.videoPrompt;

    var totalDur = _seedanceGroupDuration(group);
    var durStart = 0;
    for (var gi = 0; gi < gIdx; gi++) {
      var prevGroup = groups[gi];
      if (prevGroup) durStart += _seedanceGroupDuration(prevGroup);
    }
    var durEnd = durStart + totalDur;

    var frame = document.createElement("div");
    frame.className = "group relative cursor-pointer transition-all duration-500" +
      (isActive ? "" : " opacity-50 hover:opacity-90");
    frame.dataset.vpFrame = gIdx;

    var imgHtml = imgSrc
      ? '<img class="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" src="' + escapeHtml(imgSrc) + '" />'
      : '<div class="w-full h-full flex items-center justify-center bg-surface-container"><span class="material-symbols-outlined text-3xl text-on-surface-variant/15">movie_filter</span></div>';

    var shotLabel = group.shots.map(function (s) { return escapeHtml(s.shotType || ''); }).filter(Boolean).join(' · ');

    frame.innerHTML =
      '<div class="aspect-[21/9] rounded-xl overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.05)] bg-surface-container-lowest transition-transform duration-500 group-hover:scale-[1.02]' +
        (isActive ? ' ring-2 ring-primary/30' : '') + '">' +
        imgHtml +
      '</div>' +
      '<div class="mt-3 flex justify-between items-center px-1">' +
        '<span class="text-xs font-bold text-on-surface">' + (shotLabel || '片段 ' + (gIdx + 1)) + '</span>' +
        '<div class="flex items-center gap-2">' +
          (hasDone ? '<span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>' : '') +
          '<span class="text-[10px] bg-surface-container-highest px-3 py-1 rounded-full text-on-tertiary-container font-bold">' +
            '0:' + String(durStart).padStart(2, '0') + ' - 0:' + String(durEnd).padStart(2, '0') +
          '</span>' +
        '</div>' +
      '</div>';

    frame.addEventListener("click", function () {
      _vpSelectedGroup = gIdx;
      _renderVpStoryboardFrames();
      renderVideoPromptList();
    });

    container.appendChild(frame);
  });
}

export function renderVideoPromptList() {
  _syncRefs();
  var list = $("videoPromptList");
  if (!list || !project || !project.shots) return;
  list.innerHTML = "";
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];
  var gIdx = _vpSelectedGroup;
  if (gIdx >= groups.length) { _vpSelectedGroup = 0; gIdx = 0; }
  var group = groups[gIdx];
  if (!group) return;
  var sb = project.storyboards[gIdx] || {};
  project.storyboards[gIdx] = sb;

  var parsed = _vpEnsureCache(sb, function () { renderVideoPromptList(); });

  var tagsEl = $("vpPromptTags");
  if (tagsEl) {
    var tags = parsed.motionTags || [];
    tagsEl.innerHTML = tags.map(function (t) {
      return '<span class="bg-surface-container-highest px-4 py-1.5 rounded-full text-[10px] font-bold text-on-surface-variant">' + escapeHtml(t) + '</span>';
    }).join('');
    if (!tags.length) {
      tagsEl.innerHTML = '<span class="text-[10px] text-on-surface-variant/40 italic">生成提示词后自动生成关键词标签</span>';
    }
  }

  var card = document.createElement("div");
  card.className = "vp-card flex flex-col h-full";
  card.dataset.groupIdx = gIdx;

  if (sb.videoPrompt) {
    if (_isStale("video_prompt_" + gIdx)) {
      var staleBanner = document.createElement("div");
      staleBanner.className = "stale-banner";
      staleBanner.innerHTML = '<span class="material-symbols-outlined text-sm">warning</span> 前序内容已修改，此提示词可能需要重新生成';
      card.appendChild(staleBanner);
    }

    var sensitiveHits = parsed.sensitiveHits || [];
    if (sensitiveHits.length) {
      var senWords = sensitiveHits.map(function (h) { return h.word; });
      var senBanner = document.createElement("div");
      senBanner.className = "flex items-center gap-3 px-4 py-3 mb-3 rounded-xl bg-error/8 border border-error/15";
      senBanner.innerHTML =
        '<span class="material-symbols-outlined text-error text-base shrink-0">shield</span>' +
        '<span class="flex-1 text-xs text-error font-medium">检测到 ' + sensitiveHits.length + ' 个可能触发审核的词汇：' +
          '<span class="font-bold">' + escapeHtml(senWords.join('、')) + '</span></span>' +
        '<button type="button" class="shrink-0 px-4 py-1.5 bg-error text-on-error rounded-full text-[10px] font-bold tracking-wide hover:opacity-90 transition-all active:scale-95" data-action="fix-sensitive" data-gidx="' + gIdx + '">一键替换</button>';
      card.appendChild(senBanner);
    }

    var segments = parsed.segments || [];
    var glassPanel = document.createElement("div");
    // 用户反馈："右面按钮啥的都变形了 字体也特别大"——参考原站的紧凑排版：
    //   · padding p-10 → p-6（40 → 24px）
    //   · 段间距 space-y-8 → space-y-5（32 → 20px）
    glassPanel.className = "bg-white/40 backdrop-blur-[40px] rounded-xl p-6 border-b-2 border-primary-fixed-dim/30 shadow-sm relative overflow-y-auto no-scrollbar flex-grow";
    glassPanel.innerHTML = '<div class="absolute -right-20 -top-20 w-64 h-64 bg-primary-container/20 blur-[100px] rounded-full pointer-events-none"></div>';

    var segContainer = document.createElement("div");
    segContainer.className = "relative z-10 space-y-5";

    segments.forEach(function (seg, sIdx) {
      var segDiv = document.createElement("div");
      segDiv.className = "group/line";

      if (seg.time) {
        // 段名/时间码徽章：原站是浅灰圆角 pill，不是黑底白字 mono code 块。
        // 把"运镜系统/角色/场景/0-Xs..."这些做成温和的标签风格。
        var header = document.createElement("div");
        header.className = "flex items-center gap-3 mb-2";
        header.innerHTML =
          '<span class="text-[11px] font-semibold bg-surface-container-highest/80 text-on-surface-variant px-2.5 py-0.5 rounded-full">' + escapeHtml(seg.time) + '</span>' +
          '<div class="h-[1px] flex-grow bg-outline-variant/20"></div>' +
          '<span class="material-symbols-outlined text-xs text-outline/40 opacity-0 group-hover/line:opacity-100 transition-opacity cursor-pointer">edit</span>';
        segDiv.appendChild(header);
      }

      var p = document.createElement("p");
      // text-2xl font-light + tracking-tight 让中文挤成一团又特别巨大；
      // 改成 text-base font-normal + leading-relaxed，对应原站正常段落字号。
      p.className = "vp-seg-text text-base font-normal text-on-background leading-relaxed cursor-text hover:bg-white/30 rounded-lg transition-colors px-2 py-1 -mx-2";
      p.innerHTML = _highlightLargePrompt(seg.text, seg.highlights, sensitiveHits);
      p.title = "点击编辑";
      p.addEventListener("click", function () { _makeSegmentEditable(p, gIdx, sIdx, segments); });
      segDiv.appendChild(p);
      segContainer.appendChild(segDiv);
    });

    glassPanel.appendChild(segContainer);
    var cursor = document.createElement("div");
    cursor.className = "mt-4 inline-block w-0.5 h-4 bg-primary animate-pulse ml-1";
    glassPanel.appendChild(cursor);
    card.appendChild(glassPanel);
  } else {
    card.innerHTML =
      '<div class="bg-white/40 backdrop-blur-[40px] rounded-xl p-12 border-b-2 border-outline-variant/20 shadow-sm relative overflow-hidden flex flex-col items-center justify-center flex-grow">' +
        '<span class="material-symbols-outlined text-6xl text-on-surface-variant/15 mb-4">psychology</span>' +
        '<span class="text-sm text-on-surface-variant/40 font-medium">点击上方「生成全部」或左侧选择片段后生成</span>' +
      '</div>';
  }
  list.appendChild(card);
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
}

export function checkVideoPromptsConfirm() {
  _syncRefs();
  var area = $("videoPromptsConfirmArea");
  if (!area || !project || !project.storyboards) return;
  var groups = getStoryboardGroups();
  var allDone = groups.length > 0 && groups.every(function (_, i) {
    return project.storyboards[i] && project.storyboards[i].videoPrompt;
  });
  area.hidden = !allDone;
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
  var groups = getStoryboardGroups();
  var group = groups[gIdx];
  if (!group) return;
  if (!project.storyboards) project.storyboards = [];
  if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
  var originId = project.id;

  updateVpCard(gIdx, "loading", null, "AI 分析图片与剧本…");

  var sbData = project.storyboards[gIdx];
  var sbRawUrl = sbData && sbData.rawUrl;
  var existingVp = (sbData && sbData.videoPrompt) || "";
  var assetRefs = [];
  try {
    var refResp = await apiPost('/api/assets/match-references', {
      project: { assets: project.assets },
      group: group,
      promptText: existingVp,
    });
    assetRefs = refResp.refs || [];
  } catch (e) {
    console.warn('[VideoPrompt] match-references failed, continuing without refs:', e);
  }
  // Phase 4：旁白分配交给后端。这里把所有 group 的 shots 打包传过去——
  // allocator 需要看到全部才能做 voiceover 池均摊和"已分配"去重。
  var allGroupsShots = groups.map(function (gg) { return (gg && gg.shots) || []; });
  var allGroupsShotIndices = groups.map(function (gg) { return (gg && gg.shotIndices) || []; });

  var imageUrls = [];
  if (sbRawUrl) imageUrls.push(sbRawUrl);
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
      narrations: (project && project.narrations) || [],
      allGroupsShots: allGroupsShots,
      allGroupsShotIndices: allGroupsShotIndices,
      groupIdx: gIdx,
      totalGroups: groups.length,
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
      proj.storyboards[gIdx].narrationsUsed = narrationsUsed;
      if (proj._staleFlags) delete proj._staleFlags["video_prompt_" + gIdx];
    });
    if (isCurrent) updateVpCard(gIdx, "done", cleaned);
  } catch (e) {
    var errMsg = ((e && e.message) || e).toString().slice(0, 120);
    if (project && project.id === originId) updateVpCard(gIdx, "error", null, errMsg);
    showToast("视频提示词 #" + (gIdx + 1) + " 生成失败: " + _diagnoseApiError(errMsg), "error");
  }
}

export async function generateAllVideoPrompts() {
  // Phase 3-B-3：后端 batch_runner 编排，前端只负责 UI + subscribeBatch。
  // 已删除：plan-batch 前端回退、vpParallel/VP_FALLBACK、vpFailed 重试队列。
  // 失败用 git revert 回滚，不在前端保留 fallback。
  _syncRefs();
  if (_videoPromptsGenerating) return;
  if (!project || !project.id) { showToast("请先保存项目", "warn"); return; }
  _videoPromptsGenerating = true;
  var btn = $("btnGenAllVideoPrompts");
  var hint = $("videoPromptsHint");
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "正在批量生成视频提示词…";

  var originId = project.id;
  var groups = getStoryboardGroups();
  if (!project.storyboards) project.storyboards = [];

  var targets = [];
  for (var i = 0; i < groups.length; i++) {
    if (!project.storyboards[i] || !project.storyboards[i].videoPrompt) {
      targets.push({
        groupIdx: i,
        idx: i,
        shotIndices: groups[i].shotIndices || [],
        totalGroups: groups.length,
      });
    }
  }
  if (!targets.length) {
    // 全部都有提示词——保留旧语义（用户可能想重新生成全部）
    targets = groups.map(function (g, idx) {
      return { groupIdx: idx, idx: idx, shotIndices: g.shotIndices || [], totalGroups: groups.length };
    });
  }
  var totalCount = targets.length;
  targets.forEach(function (t) { updateVpCard(t.groupIdx, "loading", null, "AI 分析图片与剧本…"); });

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
  } catch (e) {
    console.error('[generateAllVideoPrompts] /api/batch/start failed:', e);
    var errMsg0 = ((e && e.message) || e).toString();
    if (hint) hint.textContent = "启动失败：" + errMsg0;
    showToast("批量生成启动失败：" + _diagnoseApiError(errMsg0), "error");
    targets.forEach(function (t) { updateVpCard(t.groupIdx, "error", null, "启动失败"); });
    _videoPromptsGenerating = false;
    if (btn) btn.disabled = false;
    return;
  }

  var doneCount = 0;
  var failCount = 0;
  var finished = false;
  // 去重保护：SSE + polling 同时跑，避免一个 group 处理两次
  var _seenDone = Object.create(null);
  var _seenFailed = Object.create(null);

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
      return (sb && sb.videoPrompt) || '';
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
      if (project.storyboards[j] && project.storyboards[j].videoPrompt) done++;
    }
    if (hint) hint.textContent = done + "/" + groups.length + " 条已生成";
    // 可能 reload 之后 done > 0 而 doneCount 还是 0（SSE 全丢的情况）——把卡片状态也刷一遍
    for (var jj = 0; jj < groups.length; jj++) {
      var sbJ = project.storyboards[jj];
      if (sbJ && sbJ.videoPrompt) updateVpCard(jj, "done", sbJ.videoPrompt);
    }
    var allDone = groups.length > 0 && groups.every(function (_, k) {
      return project.storyboards[k] && project.storyboards[k].videoPrompt;
    });
    if (allDone) {
      showToast("全部视频提示词已生成", "success");
    } else if (done === 0 && failCount === 0) {
      // 既没成功也没失败 = 后端任务都"completed"了但内容空 / SSE 全丢且 DB 也没写 → 一定是后端故障
      showToast("批量生成结束但 0 条返回，请检查模型 / 网络后重试", "error");
    } else if (failCount > 0) {
      showToast(failCount + " 条提示词生成失败，请手动重试", "warn");
    } else if (done < groups.length) {
      showToast("已完成 " + done + "/" + groups.length + " 条，剩余可点单条「重新生成」补齐", "warn");
    }
    checkVideoPromptsConfirm();
    setTimeout(function () { _checkAndSuggest("videoPrompts"); }, 1000);
  }

  function _applyTaskCompleted(gIdx, cleaned, narrationsUsed) {
    if (typeof gIdx !== 'number') return;
    if (_seenDone[gIdx]) return;
    if (!cleaned) {
      // SSE/polling 报告任务完成但 extra/patch 都空——后端 executor 已经写过 DB，
      // 拉回来兜底；如果 DB 里也没有，标记为失败让用户能看到"重新生成"按钮。
      _rescueFromServerForGroup(gIdx).then(function (vp) {
        if (vp) {
          _applyTaskCompleted(gIdx, vp, narrationsUsed);
        } else if (!_seenFailed[gIdx] && !_seenDone[gIdx]) {
          _applyTaskFailed(gIdx, '后端任务返回为空');
        }
      });
      return;
    }
    _seenDone[gIdx] = true;
    doneCount++;

    var isCurrent = _safeWriteBack(originId, function (proj) {
      if (!proj.storyboards) proj.storyboards = [];
      if (!proj.storyboards[gIdx]) proj.storyboards[gIdx] = {};
      proj.storyboards[gIdx].videoPrompt = cleaned;
      if (Array.isArray(narrationsUsed)) proj.storyboards[gIdx].narrationsUsed = narrationsUsed;
      if (proj._staleFlags) delete proj._staleFlags["video_prompt_" + gIdx];
    });
    if (isCurrent) updateVpCard(gIdx, "done", cleaned);
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
  }

  function _applyTaskFailed(gIdx, errMsg) {
    if (typeof gIdx !== 'number') return;
    if (_seenFailed[gIdx] || _seenDone[gIdx]) return;
    _seenFailed[gIdx] = true;
    failCount++;
    updateVpCard(gIdx, "error", null, (errMsg || '生成失败').toString().slice(0, 120));
    if (hint) hint.textContent = "生成中… " + (doneCount + failCount) + "/" + totalCount;
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
      tasks.forEach(function (t) {
        if (t.status === 'completed') {
          var result = t.result || {};
          var extra = result.extra || {};
          var patch = result.patch || {};
          var gIdx = (typeof extra.groupIdx === 'number')
            ? extra.groupIdx
            : ((t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq]);
          var cleaned = (extra.videoPrompt || patch.value || '').toString().trim().replace(/^["']|["']$/g, "");
          var narrationsUsed = Array.isArray(extra.narrationsUsed) ? extra.narrationsUsed : [];
          _applyTaskCompleted(gIdx, cleaned, narrationsUsed);
        } else if (t.status === 'failed') {
          var gIdx2 = (t.target && typeof t.target.groupIdx === 'number') ? t.target.groupIdx : seqToGroupIdx[t.seq];
          _applyTaskFailed(gIdx2, t.errorMsg);
        }
      });
      if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') {
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
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      var cleaned = (extra.videoPrompt || patch.value || '').toString().trim().replace(/^["']|["']$/g, "");
      var narrationsUsed = Array.isArray(extra.narrationsUsed) ? extra.narrationsUsed : [];
      _applyTaskCompleted(gIdx, cleaned, narrationsUsed);
    },
    onTaskFailed: function (data) {
      var extra = data.extra || {};
      var gIdx = (typeof extra.groupIdx === 'number') ? extra.groupIdx : seqToGroupIdx[data.targetSeq];
      _applyTaskFailed(gIdx, data.errorMsg);
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
  var groups = getStoryboardGroups();
  var missing = groups.filter(function (_, i) { return !project.storyboards[i] || !project.storyboards[i].videoPrompt; });
  if (missing.length) { showToast("还有 " + missing.length + " 条视频提示词未生成", "warn"); return; }
  project.videoPromptsApproved = true;
  project.currentStep = Math.max(project.currentStep, 6);
  if (_ctx.flushServerSave) {
    await _ctx.flushServerSave();
  } else {
    saveProject();
  }
  switchPage("batch");
}

export async function refineVideoPrompt(instruction) {
  _syncRefs();
  var gIdx = _vpSelectedGroup;
  if (!project || !project.storyboards || !project.storyboards[gIdx] || !project.storyboards[gIdx].videoPrompt) {
    showToast("当前片段还没有提示词，请先生成", "warn"); return;
  }
  var originId = project.id;
  var currentPrompt = project.storyboards[gIdx].videoPrompt;
  var input = $("vpRefineInput");
  var btn = $("vpBtnRefine");
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;

  try {
    var resp = await apiPostStream("/api/video-prompt/refine", {
      currentPrompt: currentPrompt,
      instruction: instruction,
    }, function () {});
    var refined = (resp.videoPrompt || "").trim().replace(/^["'`]|["'`]$/g, "");
    var isCurrent = _safeWriteBack(originId, function (proj) {
      if (proj.storyboards && proj.storyboards[gIdx]) proj.storyboards[gIdx].videoPrompt = refined;
    });
    if (isCurrent) {
      renderVideoPromptList();
      _renderVpStoryboardFrames();
      checkVideoPromptsConfirm();
      showToast("提示词已更新", "ok");
    }
  } catch (e) {
    showToast("修改失败: " + _diagnoseApiError(((e && e.message) || e).toString()), "error");
  }
  if (btn) btn.disabled = false;
  if (input) { input.disabled = false; input.value = ""; }
}

export function handleVideoPromptAction(e) {
  _syncRefs();
  var btn = e.target.closest("[data-action]");
  if (!btn) return;
  var card = btn.closest(".vp-card");
  if (!card) return;
  var gIdx = parseInt(card.dataset.groupIdx, 10);
  var action = btn.dataset.action;

  if (action === "regen-vp") {
    if (_videoPromptsGenerating) { showToast("正在批量生成中，请稍候", "warn"); return; }
    if (project.storyboards[gIdx]) project.storyboards[gIdx].videoPrompt = "";
    saveProject();
    generateGroupVideoPrompt(gIdx).then(function () { checkVideoPromptsConfirm(); });
  } else if (action === "edit-vp") {
    var current = (project.storyboards[gIdx] && project.storyboards[gIdx].videoPrompt) || "";
    var newPrompt = prompt("编辑视频提示词:", current);
    if (newPrompt !== null && newPrompt.trim()) {
      if (!project.storyboards[gIdx]) project.storyboards[gIdx] = {};
      project.storyboards[gIdx].videoPrompt = newPrompt.trim();
      _clearStale("video_prompt_" + gIdx);
      saveProject();
      renderVideoPromptList();
      _renderVpStoryboardFrames();
      checkVideoPromptsConfirm();
    }
  } else if (action === "fix-sensitive") {
    _aiFixSensitiveWords(gIdx);
  } else if (action === "delete-vp") {
    showConfirm("删除视频提示词", "确定删除片段 " + (gIdx + 1) + " 的视频提示词？", function () {
      if (project.storyboards[gIdx]) project.storyboards[gIdx].videoPrompt = "";
      saveProject();
      renderVideoPromptList();
      _renderVpStoryboardFrames();
      checkVideoPromptsConfirm();
    });
  }
}

async function _aiFixSensitiveWords(gIdx) {
  _syncRefs();
  if (!project || !project.storyboards || !project.storyboards[gIdx] || !project.storyboards[gIdx].videoPrompt) {
    showToast("当前片段还没有提示词", "warn"); return;
  }
  var currentPrompt = project.storyboards[gIdx].videoPrompt;
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
    }, function () {});
    var refined = (resp.videoPrompt || "").trim().replace(/^["'`]|["'`]$/g, "");
    if (!refined) { showToast("AI 返回为空，替换失败", "error"); return; }
    var isCurrent = _safeWriteBack(originId, function (proj) {
      if (proj.storyboards && proj.storyboards[gIdx]) {
        proj.storyboards[gIdx].videoPrompt = refined;
        if (proj.storyboards[gIdx]._vpCache) proj.storyboards[gIdx]._vpCache = null;
      }
    });
    if (isCurrent) {
      renderVideoPromptList();
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