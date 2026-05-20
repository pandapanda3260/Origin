/**
 * Settings module — model slots, load/save, settings page UI.
 * Extracted from main.js (stage 3 refactor).
 */
import { escapeHtml, showToast, apiGet, apiPost, getAuthHeaders, checkAuth, $ } from './utils.js';
const _getAuthHeaders = getAuthHeaders;
const _checkAuth = checkAuth;

// Injected from main.js at init
let settings = null;
let STORAGE_MODELS = '';
let STEP_TO_SLOT = {};
let MODEL_SLOT_META = {};
let VIDEO_ADAPTERS = {};
let IMAGE_PROVIDERS = {};

export function initSettings(ctx) {
  settings = ctx.settings;
  STORAGE_MODELS = ctx.STORAGE_MODELS;
  STEP_TO_SLOT = ctx.STEP_TO_SLOT;
  MODEL_SLOT_META = ctx.MODEL_SLOT_META;
  VIDEO_ADAPTERS = ctx.VIDEO_ADAPTERS;
  IMAGE_PROVIDERS = ctx.IMAGE_PROVIDERS;
}

  function _hydrateSettingsFromLocalStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_MODELS);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;
      ["text", "image", "multimodal", "video"].forEach(function (slot) {
        if (saved[slot]) settings.models[slot] = Object.assign(settings.models[slot], saved[slot]);
      });
    } catch (e) {}
  }

  /** 仅当服务端字段非空时覆盖（避免空 settings.json 冲掉浏览器里已保存的 Key） */
  function _applyServerModelsNonEmpty(serverModels) {
    if (!serverModels || typeof serverModels !== "object") return;
    ["text", "image", "multimodal", "video"].forEach(function (slot) {
      var inc = serverModels[slot];
      if (!inc || typeof inc !== "object") return;
      var cur = settings.models[slot];
      ["key", "base", "model"].forEach(function (k) {
        var v = inc[k] != null ? String(inc[k]).trim() : "";
        if (v) cur[k] = inc[k];
      });
      if (slot === "video" && inc.adapter != null && String(inc.adapter).trim()) {
        cur.adapter = inc.adapter;
      }
      if (slot === "image" && inc.provider != null && String(inc.provider).trim()) {
        cur.provider = inc.provider;
      }
    });
  }

  async function loadSettings() {
    _hydrateSettingsFromLocalStorage();
    refreshSettingsFormFromState();
    try {
      var resp = await fetch("/api/settings", { headers: _getAuthHeaders() });
      _checkAuth(resp);
      if (resp.status === 403) {
        refreshSettingsFormFromState();
        return;
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var data = await resp.json();
      if (data && data.models) {
        _applyServerModelsNonEmpty(data.models);
      }
    } catch (e) {
      console.warn("[Settings] 无法从服务器加载，已使用本机缓存:", e);
      showToast("设置加载失败，已使用本地记录", "warn");
    }
    refreshSettingsFormFromState();
  }

  async function saveModelSlots() {
    localStorage.setItem(STORAGE_MODELS, JSON.stringify(settings.models));
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: _getAuthHeaders(),
        body: JSON.stringify({ models: settings.models }),
      });
    } catch (e) { console.warn("[Settings] Sync to backend failed:", e); }
  }

  function getSlotConfig(stepName) {
    var slotName = STEP_TO_SLOT[stepName] || "text";
    var slot = settings.models[slotName];
    return { key: (slot.key || "").trim(), base: (slot.base || "").trim(), model: (slot.model || "").trim(), slotName: slotName };
  }

  function refreshSettingsFormFromState() {
    _renderModelSlotCards();
    _initImageProviderSelector();
    _initVideoAdapterSelector();
  }

  function wireSettingsPageOnce() {
    var btn = $("btnSaveAllSettings");
    if (!btn || btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", function () {
      // text / multimodal 由平台 key pool 统一管理，只保存 image / video 两个 BYOK slot
      ["image", "video"].forEach(function (slot) {
        var keyEl = $("slot_" + slot + "_key");
        var baseEl = $("slot_" + slot + "_base");
        var modelEl = $("slot_" + slot + "_model");
        if (keyEl) settings.models[slot].key = keyEl.value.trim();
        if (baseEl) settings.models[slot].base = baseEl.value.trim();
        if (modelEl) settings.models[slot].model = modelEl.value.trim();
      });
      var providerSel = $("imageProviderSelect");
      if (providerSel) {
        if (!settings.models.image) settings.models.image = {};
        settings.models.image.provider = providerSel.value;
      }
      var adapterSel = $("videoAdapterSelect");
      if (adapterSel) {
        settings.models.video.adapter = adapterSel.value;
      }
      saveModelSlots();
      showToast("全部配置已保存", "ok");
    });

    var testBtn = $("btnTestAllApis");
    if (testBtn) testBtn.addEventListener("click", _testAllApiConnections);
  }

  async function _testAllApiConnections() {
    var btn = $("btnTestAllApis");
    var resultsDiv = $("apiTestResults");
    if (!btn || !resultsDiv) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined text-lg animate-spin">progress_activity</span>测试中…';
    resultsDiv.classList.remove("hidden");
    resultsDiv.innerHTML = "";

    // Video API key is platform-managed now —普通用户只测 image。
    // 独立后台不再复用普通用户身份，旧工作台不展示视频 BYOK 测试。
    var showVideoSlot = await _canShowPlatformVideoControls();
    var slots = showVideoSlot && (settings.models.video.key || "").trim()
      ? ["image", "video"]
      : ["image"];
    var slotLabels = { image: "图片生成模型", video: "视频生成模型" };
    var html = "";

    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var label = slotLabels[slot];
      var hasKey = (settings.models[slot].key || "").trim();
      var hasBase = (settings.models[slot].base || "").trim();
      if (!hasKey || !hasBase) {
        html += _testResultCard(label, "skip", "未配置", "");
        continue;
      }
      resultsDiv.innerHTML = html + _testResultCard(label, "loading", "测试中…", "");
      try {
        var resp = await fetch("/api/settings/test", {
          method: "POST",
          headers: _getAuthHeaders(),
          body: JSON.stringify({ slot: slot }),
        });
        var text = await resp.text();
        if (text.trim().charAt(0) === "<") {
          html += _testResultCard(label, "fail", "后端服务未运行", "服务器返回了 HTML 错误页面（HTTP " + resp.status + "），请检查后端服务是否正常启动");
          continue;
        }
        var data = JSON.parse(text);
        if (data.ok) {
          html += _testResultCard(label, "ok", "连接成功", "模型: " + escapeHtml(data.model || "") + (data.reply ? " · 回复: " + escapeHtml(data.reply) : ""));
        } else {
          html += _testResultCard(label, "fail", escapeHtml(data.error || "未知错误"), data.hint ? escapeHtml(data.hint) : "");
        }
      } catch (e) {
        html += _testResultCard(label, "fail", "请求失败: " + escapeHtml(String(e.message || e).slice(0, 100)), "");
      }
    }
    resultsDiv.innerHTML = html;
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined text-lg">network_check</span>测试连接';
  }

  function _testResultCard(label, status, msg, detail) {
    var icon, color, bg;
    if (status === "ok")      { icon = "check_circle"; color = "#4CAF50"; bg = "#E8F5E9"; }
    else if (status === "fail") { icon = "error";        color = "#E53935"; bg = "#FFEBEE"; }
    else if (status === "skip") { icon = "remove_circle_outline"; color = "#9E9E9E"; bg = "#F5F5F5"; }
    else                        { icon = "progress_activity";     color = "#1976D2"; bg = "#E3F2FD"; }
    return '<div class="flex items-start gap-3 p-3 rounded-lg mb-2" style="background:' + bg + '">' +
      '<span class="material-symbols-outlined" style="color:' + color + ';font-size:20px;margin-top:1px">' + icon + '</span>' +
      '<div class="flex-1 min-w-0">' +
        '<div class="text-sm font-bold" style="color:' + color + '">' + escapeHtml(label) + '</div>' +
        '<div class="text-xs mt-0.5" style="color:#555">' + msg + '</div>' +
        (detail ? '<div class="text-[11px] mt-1" style="color:#888">' + detail + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  // 独立后台身份已与普通工作台彻底分离，这里不再从 /api/auth/me 推断后台身份。
  async function _canShowPlatformVideoControls() {
    return false;
  }

  function _renderModelSlotCards() {
    var container = $("modelSlotsContainer");
    if (!container) return;
    container.innerHTML = "";
    // 视频模型统一由后端 key pool 管理，普通用户不再看到视频 BYOK 卡片。
    // 管理员额外看到视频池状态小卡（异步追加）。
    var slots = ["image"];
    var stepsBySlot = {};
    for (var step in STEP_TO_SLOT) {
      var s = STEP_TO_SLOT[step];
      if (!stepsBySlot[s]) stepsBySlot[s] = [];
      stepsBySlot[s].push(step);
    }

    var STEP_CN = {
      script: "剧本生成", styleBible: "风格圣经", assetExtract: "资产提取",
      shots: "镜头设计", imagePrompt: "提示词生成", assetImages: "资产参考图",
      images: "分镜图", motionDesign: "运镜设计", video: "视频生成"
    };
    var SLOT_HINTS = {
      text: {
        base: "服务商提供的接口地址，填到域名即可，不用带 /v1",
        key: "在服务商后台获取",
        model: "如 gpt-4o, deepseek-chat, qwen-max 等"
      },
      image: {
        base: "支持 OpenAI 兼容格式的图片 API 地址",
        key: "在服务商后台获取",
        model: "如 gpt-image-1, flux-1.1-pro, dall-e-3 等",
        note: "支持同步和异步两种 API，系统自动检测，无需额外配置"
      },
      multimodal: {
        base: "需支持看图理解 + 图片生成的模型",
        key: "在服务商后台获取",
        model: "如 gemini-2.5-pro, gpt-4o 等"
      },
      video: {
        base: "视频生成 API 地址",
        key: "在服务商后台获取",
        model: "如 doubao-seedance-2-0-260128 等"
      }
    };
    var SLOT_EXAMPLES = {
      text: [
        { provider: "OpenAI", base: "https://api.openai.com", model: "gpt-4o" },
        { provider: "DeepSeek", base: "https://api.deepseek.com", model: "deepseek-chat" },
        { provider: "阿里云/通义", base: "https://dashscope.aliyuncs.com/compatible-mode", model: "qwen-max" },
        { provider: "SiliconFlow", base: "https://api.siliconflow.cn", model: "deepseek-ai/DeepSeek-V3" },
      ],
      image: [
        { provider: "OpenAI", base: "https://api.openai.com", model: "gpt-image-1" },
        { provider: "Google", base: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash-preview-image-generation" },
        { provider: "SiliconFlow", base: "https://api.siliconflow.cn", model: "stabilityai/stable-diffusion-3-5-large" },
      ],
      multimodal: [
        { provider: "Google", base: "https://generativelanguage.googleapis.com", model: "gemini-2.5-pro" },
        { provider: "OpenAI", base: "https://api.openai.com", model: "gpt-4o" },
        { provider: "SiliconFlow", base: "https://api.siliconflow.cn", model: "Qwen/Qwen2.5-VL-72B-Instruct" },
      ],
      video: [
        { provider: "火山方舟(豆包)", base: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedance-2-0-260128" },
        { provider: "快手(可灵)", base: "https://api.klingai.com", model: "kling-v2" },
        { provider: "MiniMax(海螺)", base: "https://api.minimax.chat", model: "video-01" },
        { provider: "生数(Vidu)", base: "https://api.vidu.com", model: "vidu-2.0" },
      ],
    };

    slots.forEach(function (slot) {
      var meta = MODEL_SLOT_META[slot];
      var current = settings.models[slot];
      var hints = SLOT_HINTS[slot] || {};
      var sec = document.createElement("section");
      sec.className = "bg-surface-container-lowest rounded-xl p-8 border border-outline-variant/10 shadow-sm";
      var stepsUsing = (stepsBySlot[slot] || []).join("、");

      var hintClass = "text-[10px] text-on-surface-variant/40 mt-1";
      var noteHtml = "";
      if (hints.note) {
        noteHtml =
          '<div class="mt-4 flex items-start gap-2 px-3 py-2.5 bg-primary/5 rounded-lg border border-primary/10">' +
            '<span class="material-symbols-outlined text-primary text-sm mt-0.5">info</span>' +
            '<span class="text-[11px] text-on-surface-variant leading-relaxed">' + hints.note + '</span>' +
          '</div>';
      }

      var stepsArr = (stepsBySlot[slot] || []).map(function (s) { return STEP_CN[s] || s; });
      var stepsHtml = stepsArr.length
        ? '<div class="flex flex-wrap gap-1.5 mt-2">' + stepsArr.map(function (s) { return '<span class="inline-block text-[10px] px-2 py-0.5 rounded-full bg-primary/8 text-primary/80 border border-primary/10">' + escapeHtml(s) + '</span>'; }).join("") + '</div>'
        : "";

      var examples = SLOT_EXAMPLES[slot] || [];
      var exHtml = "";
      if (examples.length) {
        var exId = "slotEx_" + slot;
        var rows = examples.map(function (ex) {
          return '<tr class="border-b border-outline-variant/5">' +
            '<td class="py-1.5 pr-3 font-medium whitespace-nowrap">' + escapeHtml(ex.provider) + '</td>' +
            '<td class="py-1.5 pr-3"><code class="text-[10px] bg-surface-container-low px-1.5 py-0.5 rounded select-all">' + escapeHtml(ex.base) + '</code></td>' +
            '<td class="py-1.5"><code class="text-[10px] bg-surface-container-low px-1.5 py-0.5 rounded select-all">' + escapeHtml(ex.model) + '</code></td>' +
          '</tr>';
        }).join("");
        exHtml =
          '<details class="mt-4 group" id="' + exId + '">' +
            '<summary class="cursor-pointer text-[11px] text-primary/70 hover:text-primary select-none flex items-center gap-1">' +
              '<span class="material-symbols-outlined text-sm transition-transform group-open:rotate-90">chevron_right</span>' +
              '常见供应商配置示例' +
            '</summary>' +
            '<div class="mt-2 overflow-x-auto">' +
              '<table class="w-full text-[11px] text-on-surface-variant">' +
                '<thead><tr class="border-b border-outline-variant/15"><th class="text-left py-1 pr-3 font-bold">供应商</th><th class="text-left py-1 pr-3 font-bold">API 地址</th><th class="text-left py-1 font-bold">模型名称</th></tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
              '</table>' +
            '</div>' +
          '</details>';
      }

      sec.innerHTML =
        '<div class="flex items-start gap-4 mb-6">' +
          '<span class="material-symbols-outlined text-primary text-2xl mt-1">' + meta.icon + '</span>' +
          '<div class="flex-1">' +
            '<h3 class="text-lg font-bold text-on-background">' + meta.label + '</h3>' +
            '<p class="text-xs text-on-surface-variant mt-1">' + meta.desc + '</p>' +
            stepsHtml +
          '</div>' +
        '</div>' +
        '<div class="space-y-4">' +
          '<div>' +
            '<label class="text-xs font-bold text-on-surface-variant block mb-1.5">API 地址</label>' +
            '<input type="text" id="slot_' + slot + '_base" placeholder="https://api.openai.com" spellcheck="false" autocomplete="off" value="' + escapeHtml(current.base || "") + '" class="w-full bg-surface-container-low border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm focus:ring-1 focus:ring-primary/30" />' +
            '<p class="' + hintClass + '">' + escapeHtml(hints.base || "") + '</p>' +
          '</div>' +
          '<div>' +
            '<label class="text-xs font-bold text-on-surface-variant block mb-1.5">API Key</label>' +
            '<input type="password" id="slot_' + slot + '_key" placeholder="sk-…" autocomplete="off" value="' + escapeHtml(current.key || "") + '" class="w-full bg-surface-container-low border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm focus:ring-1 focus:ring-primary/30" />' +
            '<p class="' + hintClass + '">' + escapeHtml(hints.key || "") + '</p>' +
          '</div>' +
          '<div>' +
            '<label class="text-xs font-bold text-on-surface-variant block mb-1.5">模型名称</label>' +
            '<input type="text" id="slot_' + slot + '_model" placeholder="' + escapeHtml(meta.placeholderModel) + '" spellcheck="false" autocomplete="off" value="' + escapeHtml(current.model || "") + '" class="w-full bg-surface-container-low border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm focus:ring-1 focus:ring-primary/30" />' +
            '<p class="' + hintClass + '">' + escapeHtml(hints.model || "") + '</p>' +
          '</div>' +
        '</div>' +
        noteHtml +
        exHtml;
      container.appendChild(sec);
    });

    _renderVideoModelCard(container);
  }

  function _renderVideoModelCard(container) {
    var sec = document.createElement("section");
    sec.className = "bg-surface-container-lowest rounded-xl p-8 border border-outline-variant/10 shadow-sm";
    sec.id = "videoModelCard";
    sec.innerHTML =
      '<div class="flex items-start gap-4 mb-6">' +
        '<span class="material-symbols-outlined text-primary text-2xl mt-1">videocam</span>' +
        '<div class="flex-1">' +
          '<h3 class="text-lg font-bold text-on-background">视频生成模型</h3>' +
          '<p class="text-xs text-on-surface-variant mt-1" id="videoModelCardDesc">视频模型由系统统一调度，无需配置。</p>' +
        '</div>' +
      '</div>' +
      '<div id="videoModelPoolStatus" class="text-xs text-on-surface-variant"></div>';
    container.appendChild(sec);

    // 独立后台里看模型池状态；普通工作台不再展示这块内部监控。
    _canShowPlatformVideoControls().then(function (visible) {
      if (!visible) return;
      var desc = $("videoModelCardDesc");
      if (desc) desc.textContent = "管理员视图：实时监控 3 个视频模型的通道健康。";
      _refreshVideoPoolStatus();
    });
  }

  async function _refreshVideoPoolStatus() {
    var box = $("videoModelPoolStatus");
    if (!box) return;
    box.innerHTML = '<p class="text-[11px] text-on-surface-variant/60">加载中…</p>';

    // 取管理员 token：放在 localStorage 的 sw_admin_token 里（手动填/登录时注入）。
    // 如果没配，就降级显示"需配置 KEY_POOL_ADMIN_TOKEN"提示。
    var adminToken = "";
    try { adminToken = localStorage.getItem("sw_admin_token") || ""; } catch (_e) {}

    if (!adminToken) {
      box.innerHTML =
        '<p class="text-[11px] text-on-surface-variant/60 leading-relaxed">' +
        '未配置 <code>sw_admin_token</code>，前端无法直接拉取池状态。' +
        '可 SSH 到服务器用 <code>python scripts/skp_watch.py</code> 查看实时监控。' +
        '</p>';
      return;
    }
    try {
      var resp = await fetch("/api/admin/key-pool/status", {
        headers: { "X-Admin-Token": adminToken },
      });
      if (!resp.ok) {
        box.innerHTML = '<p class="text-[11px] text-red-400">拉取失败 HTTP ' + resp.status + '</p>';
        return;
      }
      var data = await resp.json();
      var pools = (data && data.slots) || {};
      var VIDEO_POOLS = {
        "video_seedance":      "Seedance",
        "video_seedance_fast": "Seedance Fast",
        "video_kling":         "可灵",
      };
      var rows = "";
      for (var poolId in VIDEO_POOLS) {
        var label = VIDEO_POOLS[poolId];
        var entries = pools[poolId] || [];
        var chips = entries.map(function (e) {
          var color = "#4CAF50";
          if (e.cooldownRemaining > 0) color = "#E53935";
          else if (e.healthScore < 0) color = "#FB8C00";
          var sr = (e.successLast1h + e.failLast1h) > 0
            ? e.successLast1h + "/" + (e.successLast1h + e.failLast1h)
            : "-";
          return '<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-container-low border border-outline-variant/15 text-[10px]">' +
            '<span style="width:6px;height:6px;border-radius:999px;background:' + color + ';"></span>' +
            '<span class="font-medium">' + escapeHtml(e.name) + '</span>' +
            '<span class="text-on-surface-variant/60">health ' + e.healthScore + ' · 1h ' + sr + '</span>' +
            '</span>';
        }).join(" ");
        rows += '<div class="py-3 border-b border-outline-variant/10 last:border-0">' +
          '<div class="text-xs font-bold text-on-surface mb-2">' + label +
          ' <span class="text-[10px] text-on-surface-variant/50 font-normal">· ' + poolId + '</span></div>' +
          '<div class="flex flex-wrap gap-1.5">' + (chips || '<span class="text-[10px] text-on-surface-variant/40">池空</span>') + '</div>' +
          '</div>';
      }
      box.innerHTML = rows;
    } catch (e) {
      box.innerHTML = '<p class="text-[11px] text-red-400">拉取失败：' + escapeHtml(String(e.message || e)) + '</p>';
    }
  }

  function _initVideoAdapterSelector() {
    var sel = $("videoAdapterSelect");
    var info = $("videoAdapterInfo");
    if (!sel) return;
    // 视频 adapter 设置只在独立后台治理，不在普通工作台展示。
    var section = sel.closest("section");
    _canShowPlatformVideoControls().then(function (visible) {
      if (section) section.style.display = visible ? "" : "none";
    });
    sel.innerHTML = "";
    for (var id in VIDEO_ADAPTERS) {
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = VIDEO_ADAPTERS[id].name;
      if (id === (settings.models.video.adapter || "openai_compat")) opt.selected = true;
      sel.appendChild(opt);
    }
    function onAdapterChange() {
      var a = VIDEO_ADAPTERS[sel.value];
      if (!a) return;
      info.innerHTML = '发送：<code>' + escapeHtml(a.submitPath) + '</code> · 查询：<code>' + escapeHtml(a.pollPath) + '</code>';
    }
    sel.addEventListener("change", onAdapterChange);
    onAdapterChange();
  }

  function _initImageProviderSelector() {
    var sel = $("imageProviderSelect");
    var info = $("imageProviderInfo");
    if (!sel) return;
    sel.innerHTML = "";
    var current = (settings.models.image && settings.models.image.provider) || "openai_compat";
    for (var id in IMAGE_PROVIDERS) {
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = IMAGE_PROVIDERS[id].name;
      if (id === current) opt.selected = true;
      sel.appendChild(opt);
    }
    function onProviderChange() {
      var p = IMAGE_PROVIDERS[sel.value];
      if (!p) return;
      info.innerHTML = escapeHtml(p.hint);
    }
    sel.addEventListener("change", onProviderChange);
    onProviderChange();
  }


export { loadSettings, saveModelSlots, getSlotConfig, refreshSettingsFormFromState, wireSettingsPageOnce };
