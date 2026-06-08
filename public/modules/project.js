/**
 * Project persistence — load, save, serialize, task recovery.
 * Extracted from main.js (stage 3 refactor).
 */
import {
  showToast,
  apiPost,
  apiGet,
  getAuthHeaders,
  checkAuth,
  hydrateProjectAssetUrls,
  escapeHtml,
  fetchAssetSignedUrl,
  fetchVideoSignedUrl,
} from './utils.js?v=201';

let _ctx = {};

// Constants injected from main.js via initProject(ctx)
// Phase 5.9：`_STORAGE_PROJECT` 作为"当前项目完整快照"的 localStorage 影子
// 拷贝已经废弃——保留函数只用于启动时清理历史残留（see `_purgeLegacyProjectShadow`）。
function _STORAGE_PROJECT() { return _ctx.STORAGE_PROJECT || ''; }
function _LAST_PROJECT_ID_KEY() { return (_ctx.uPrefix || '') + 'sw_last_project_id'; }
function _uPrefix() { return _ctx.uPrefix || ''; }
function _EPISODE_FIELDS() { return _ctx.EPISODE_FIELDS || []; }
const _MAX_IMAGE_HISTORY = 20;
const _VP_CACHE_VERSION = 2;

// Auth helpers — use imported names directly
const _getAuthHeaders = getAuthHeaders;
const _checkAuth = checkAuth;

// project/videoState proxied from main.js via ctx
function _getProject() { return _ctx.getProject ? _ctx.getProject() : null; }
function _setProject(p) { if (_ctx.setProject) _ctx.setProject(p); }
function _getVideoState() { return _ctx.getVideoState ? _ctx.getVideoState() : {}; }

export function initProject(ctx) { _ctx = ctx; }
export function getProject() { return _getProject(); }

function _archiveImageUrl(sb) {
  if (!sb) return "";
  return sb.imageUrl || sb.rawUrl || sb.firstFrameUrl || (sb.frames && sb.frames.first && sb.frames.first.url) || "";
}

function _archiveTailUrl(sb) {
  if (!sb) return "";
  return sb.tailFrameUrl || (sb.frames && sb.frames.tail && sb.frames.tail.url) || "";
}

function _archiveVideoUrl(sb, vt) {
  if (sb && (sb.videoUrl || sb._originVideoUrl)) return sb.videoUrl || sb._originVideoUrl;
  if (vt && (vt.url || vt.videoUrl || vt.protectedUrl || vt._originVideoUrl)) {
    return vt.url || vt.videoUrl || vt.protectedUrl || vt._originVideoUrl;
  }
  return "";
}

async function _resolveArchiveUrl(url, kind) {
  url = String(url || "").trim();
  if (!url) return "";
  if (kind === "video") return await fetchVideoSignedUrl(url);
  var m = /\/api\/images\/file\/([0-9a-fA-F-]{36})/.exec(url);
  if (m) return await fetchAssetSignedUrl(m[1]);
  return url;
}

async function _downloadArchiveMedia(url, kind) {
  var resolved = await _resolveArchiveUrl(url, kind);
  if (!resolved) {
    showToast("没有可下载的文件", "warn");
    return;
  }
  var a = document.createElement("a");
  a.href = resolved;
  a.target = "_blank";
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { try { a.remove(); } catch (_) {} }, 0);
}

function _closeLegacyStoryboardArchive() {
  var old = document.getElementById("legacyStoryboardArchiveModal");
  if (old) old.remove();
  document.removeEventListener("keydown", _legacyArchiveEsc, true);
}

function _legacyArchiveEsc(e) {
  if (e.key === "Escape") _closeLegacyStoryboardArchive();
}

function _openLegacyStoryboardArchive() {
  var proj = _getProject();
  var archive = Array.isArray(proj && proj.legacyStoryboardArchive) ? proj.legacyStoryboardArchive : [];
  _closeLegacyStoryboardArchive();
  var modal = document.createElement("div");
  modal.id = "legacyStoryboardArchiveModal";
  modal.className = "legacy-archive-modal";
  var rows = archive.map(function (item, idx) {
    var sb = item && item.storyboard ? item.storyboard : {};
    var vt = item && item.videoTask ? item.videoTask : {};
    var imageUrl = _archiveImageUrl(sb);
    var tailUrl = _archiveTailUrl(sb);
    var videoUrl = _archiveVideoUrl(sb, vt);
    var shots = Array.isArray(item && item.oldShotIndices)
      ? item.oldShotIndices.map(function (n) { return Number(n) + 1; }).filter(function (n) { return Number.isFinite(n); }).join("、")
      : "";
    var title = "旧槽位 " + (Number(item && item.oldGroupIdx) + 1 || idx + 1);
    if (shots) title += " / 原镜头 " + shots;
    return '' +
      '<section class="legacy-archive-item">' +
        '<div class="legacy-archive-media">' +
          (imageUrl
            ? '<img data-archive-img="' + escapeHtml(imageUrl) + '" alt="旧首帧图" />'
            : '<div class="legacy-archive-empty">无首帧图</div>') +
        '</div>' +
        '<div class="legacy-archive-body">' +
          '<div class="legacy-archive-title">' + escapeHtml(title) + '</div>' +
          '<div class="legacy-archive-meta">' + escapeHtml(item && item.archivedAt ? item.archivedAt : "已归档") + '</div>' +
          '<div class="legacy-archive-actions">' +
            (imageUrl ? '<button type="button" data-archive-download="image" data-url="' + escapeHtml(imageUrl) + '">下载首帧</button>' : '') +
            (tailUrl ? '<button type="button" data-archive-download="image" data-url="' + escapeHtml(tailUrl) + '">下载尾帧</button>' : '') +
            (videoUrl ? '<button type="button" data-archive-download="video" data-url="' + escapeHtml(videoUrl) + '">下载视频</button>' : '') +
          '</div>' +
        '</div>' +
      '</section>';
  }).join("");
  modal.innerHTML = '' +
    '<div class="legacy-archive-backdrop" data-archive-close="1"></div>' +
    '<div class="legacy-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="legacyArchiveTitle">' +
      '<header class="legacy-archive-header">' +
        '<div>' +
          '<h2 id="legacyArchiveTitle">旧版多镜头生成历史</h2>' +
          '<p>这些内容只读归档，可查看和下载，不会参与当前生成链路。</p>' +
        '</div>' +
        '<button type="button" class="legacy-archive-close material-symbols-outlined" data-archive-close="1" aria-label="关闭">close</button>' +
      '</header>' +
      '<div class="legacy-archive-list">' + (rows || '<div class="legacy-archive-empty">暂无归档内容</div>') + '</div>' +
    '</div>';
  modal.addEventListener("click", function (e) {
    var close = e.target && e.target.closest && e.target.closest("[data-archive-close]");
    if (close) {
      _closeLegacyStoryboardArchive();
      return;
    }
    var btn = e.target && e.target.closest && e.target.closest("[data-archive-download]");
    if (btn) {
      _downloadArchiveMedia(btn.getAttribute("data-url") || "", btn.getAttribute("data-archive-download") || "");
    }
  });
  document.body.appendChild(modal);
  document.addEventListener("keydown", _legacyArchiveEsc, true);
  modal.querySelectorAll("[data-archive-img]").forEach(function (img) {
    var raw = img.getAttribute("data-archive-img") || "";
    _resolveArchiveUrl(raw, "image").then(function (url) {
      if (url) img.setAttribute("src", url);
    });
  });
}

function _maybeShowLegacyStoryboardArchiveNotice(proj) {
  var archive = Array.isArray(proj && proj.legacyStoryboardArchive) ? proj.legacyStoryboardArchive : [];
  var count = Number(proj && proj.legacyStoryboardArchiveLastCount) || archive.length || 0;
  if (!proj || !proj.id || count <= 0 || !archive.length) return;
  var stamp = proj.legacyStoryboardArchiveLastMigratedAt || String(count);
  var key = _uPrefix() + "legacy_storyboard_archive_seen_" + proj.id + "_" + stamp;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (_) {}
  showToast("已归档 " + count + " 个旧版多镜头生成结果", "info", [
    { label: "查看归档", onClick: _openLegacyStoryboardArchive },
  ]);
}

function _updateLegacyStoryboardArchiveEntry(proj) {
  var entry = document.getElementById("legacyStoryboardArchiveEntry");
  if (!entry) return;
  var archive = Array.isArray(proj && proj.legacyStoryboardArchive) ? proj.legacyStoryboardArchive : [];
  if (!proj || !archive.length) {
    entry.classList.add("hidden");
    var navEmpty = document.getElementById("navLegacyStoryboardArchive");
    if (navEmpty) navEmpty.hidden = true;
    return;
  }
  entry.classList.remove("hidden");
  var summary = document.getElementById("legacyStoryboardArchiveSummary");
  if (summary) summary.textContent = "已归档 " + archive.length + " 条旧版生成结果，可查看、下载，不会参与当前生成链路。";
  var btn = document.getElementById("btnOpenLegacyStoryboardArchive");
  if (btn && !btn.__legacyArchiveBound) {
    btn.__legacyArchiveBound = true;
    btn.addEventListener("click", _openLegacyStoryboardArchive);
  }
  var nav = document.getElementById("navLegacyStoryboardArchive");
  if (nav) {
    nav.hidden = false;
    if (!nav.__legacyArchiveBound) {
      nav.__legacyArchiveBound = true;
      nav.addEventListener("click", _openLegacyStoryboardArchive);
    }
  }
}

  /**
   * Phase 5.9：启动时清理掉历史版本写到 localStorage 的"当前项目完整快照"
   * （`sw_project`、`sw_proj_<id>`），避免跨版本升级后旧影子数据被老代码路径
   * 误读回内存。只跑一次（靠 try/catch 吞异常），不阻塞启动。
   */
  function _purgeLegacyProjectShadow() {
    try {
      var curKey = _STORAGE_PROJECT();
      if (curKey) localStorage.removeItem(curKey);
      var prefix = _uPrefix() + "sw_proj_";
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) toRemove.push(k);
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
      // Phase 5.9：把 `sw_project_list`（仅 id+name 的项目索引）也一起清掉。
      // 老用户本地可能残留重构前写入的 10 条旧元数据，但服务器端 `project.json`
      // 目录是空的——导致"主界面空白但新建报配额已满"。清掉后下一句 loadProject
      // 的 fetch 成功分支会用服务器列表重建它，失败分支则保持为空也无害。
      try { localStorage.removeItem(_uPrefix() + "sw_project_list"); } catch (_) {}
    } catch (_) {}
  }

  /**
   * Phase 5.9：服务器权威 · 启动时加载项目。
   *
   * 旧实现先读 `localStorage.sw_project` 的整包快照回填内存再异步拉服务器对账
   * 的"双写"路径已经彻底作废——那是"刷新丢状态 / 刷新后转圈图标不更新"的
   * 病根。现在无论什么情况都只向后端要数据：
   *   1. 清掉历史遗留的 `sw_project` / `sw_proj_<id>` 影子。
   *   2. GET /api/projects 拉清单，同步本地项目列表（`sw_project_list` 只是
   *      侧栏显示缓存，不承载业务字段）。
   *   3. 用 `sw_last_project_id`（只记一个 projectId 字符串）回忆"上次打开的
   *      项目"；没有就取清单里按 `updatedAt` 最近的那个。
   *   4. GET /api/projects/{id} 拿完整项目 JSON（含 version / updatedAt）→
   *      `_setProject` + `hydrateProjectAssetUrls` → `refreshAllPages`。
   *   5. 串起 `_ensureEpisodes / restoreAssetGenStatus / restoreVideoTasks /
   *      recoverTasksFromServer` 等"刷新后兜底"钩子——这些钩子本身都是问
   *      服务器（batch_runner、task_store），不会读 localStorage。
   *
   * 加载期间页面上显示骨架屏（caller 在 boot 流程里先显示 splash，等
   * `loadProject()` resolve 再切 overview）。这条路径可能让用户多看 0.5–2s
   * 空白，但换来的是"刷新后一定是服务器权威状态"——即梦/tapnow 这些平台也
   * 都是这个语义。
   *
   * 注意：本函数返回 Promise，调用方 `await loadProject()`；不 await 也能工作
   * （内部异常全部 catch），但页面短时间会没项目。
   */
  // 给 fetch 加硬超时：浏览器默认无限等，某些场景下（后端 TCP 接连却不返回、
  // 维护期反代 timeout、扩展拦截）会导致 loadProject 里的 await 永远不 resolve，
  // 骨架屏随之永远不关。10s 超时后转成 AbortError 抛出，由外层 try/catch 吞掉。
  async function _fetchWithTimeout(url, options, timeoutMs) {
    options = options || {};
    timeoutMs = timeoutMs || 10000;
    var externalSignal = options.signal || null;
    var ctl = (typeof AbortController === "function") ? new AbortController() : null;
    var timer = null;
    var onAbort = null;
    if (ctl) {
      if (externalSignal) {
        if (externalSignal.aborted) {
          try { ctl.abort(); } catch (_) {}
        } else if (typeof externalSignal.addEventListener === "function") {
          onAbort = function () { try { ctl.abort(); } catch (_) {} };
          externalSignal.addEventListener("abort", onAbort, { once: true });
        }
      }
      options = Object.assign({}, options, { signal: ctl.signal });
      timer = setTimeout(function () { try { ctl.abort(); } catch (_) {} }, timeoutMs);
    }
    try {
      return await fetch(url, options);
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal && onAbort && typeof externalSignal.removeEventListener === "function") {
        try { externalSignal.removeEventListener("abort", onAbort); } catch (_) {}
      }
    }
  }

  var _projectFetchInFlight = Object.create(null);

  async function fetchProjectByIdShared(projId, options) {
    options = options || {};
    if (!projId) return null;
    var key = String(projId);
    if (!options.force && _projectFetchInFlight[key]) return _projectFetchInFlight[key];
    var promise = (async function () {
      try {
        var resp = await _fetchWithTimeout(
          "/api/projects/" + encodeURIComponent(key),
          { headers: _getAuthHeaders(), signal: options.signal },
          options.timeoutMs || 10000,
        );
        _checkAuth(resp);
        if (!resp.ok) return null;
        var data = await resp.json();
        return (data && data.id) ? data : null;
      } catch (e) {
        if (!(e && (e.name === "AbortError" || e.code === 20))) {
          console.warn("[fetchProjectByIdShared] failed:", e);
        }
        return null;
      }
    })();
    _projectFetchInFlight[key] = promise;
    promise.finally(function () {
      if (_projectFetchInFlight[key] === promise) delete _projectFetchInFlight[key];
    });
    return promise;
  }

  async function loadProject() {
    try { _purgeLegacyProjectShadow(); } catch (_) {}

    if (_ctx.showProjectSkeleton) {
      try { _ctx.showProjectSkeleton(true); } catch (_) {}
    }

    try {
      var serverList = [];
      try {
        var resp = await _fetchWithTimeout(
          "/api/projects",
          { headers: _getAuthHeaders() },
          10000,
        );
        _checkAuth(resp);
        if (resp.ok) {
          var data = await resp.json();
          serverList = data.projects || [];
          // Phase 5.9：服务器列表 = 项目清单的唯一权威源。直接覆盖
          // `sw_project_list`——而不是"并集追加"——避免 localStorage 残留的
          // 陈旧元数据让前端配额检查误判（历史症状：服务器 0 项但本地 10 项
          // 旧元数据导致新建时报"已满 10 个"）。
          // 失败（404/503/网络错误）不覆盖：维护期 / 抖动时保留 local list，
          // 等下次 fetch 成功再对齐。
          if (_ctx.saveProjectList) {
            _ctx.saveProjectList(serverList.map(function (sp) {
              return { id: sp.id, name: sp.name, createdAt: sp.createdAt };
            }));
          }
        } else {
          console.warn("[loadProject] GET /api/projects non-2xx:", resp.status);
        }
      } catch (e) {
        console.warn("[loadProject] list failed:", e);
      }

      var targetId = "";
      try { targetId = localStorage.getItem(_LAST_PROJECT_ID_KEY()) || ""; } catch (_) {}
      if (targetId && !serverList.some(function (sp) { return sp.id === targetId; })) {
        targetId = "";
      }
      if (!targetId && serverList.length > 0) {
        var sorted = serverList.slice().sort(function (a, b) {
          return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
        });
        targetId = sorted[0].id;
      }

      if (targetId) {
        var srv = null;
        try { srv = await fetchProjectFromServer(targetId); } catch (_) {}
        if (srv && srv.id) {
          _setProject(srv);
          _updateLegacyStoryboardArchiveEntry(srv);
          _maybeShowLegacyStoryboardArchiveNotice(srv);
          try { localStorage.setItem(_LAST_PROJECT_ID_KEY(), srv.id); } catch (_) {}
          // Phase 5.9 bugfix：`hydrateProjectAssetUrls` 会并发发 N 次
          // `/api/asset/<id>/url` 请求（项目里每张图 / 每段视频都得签名一次），
          // 任何一条 hang 住都会让整个 Promise.all 卡死——外层 loadProject 的
          // try/finally 因此也不退出，`refreshAllPages()` 永远跑不到，侧边栏就
          // 空白给用户看（症状：项目在服务器上有 10 个但前端列表渲染不出来）。
          // 改成后台 fire-and-forget：先让 UI 拿到项目元数据和 storyboards 渲染
          // 骨架（没签名 URL 的图会显示占位），hydrate 完成后再触发一次 refresh
          // 把真正的 URL 补上。单条失败不影响别人。
          (function runHydrateInBackground(proj) {
            hydrateProjectAssetUrls(proj)
              .then(function () {
                try {
                  if (_ctx.refreshActivePage) _ctx.refreshActivePage();
                  else if (_ctx.refreshAllPages) _ctx.refreshAllPages();
                } catch (_) {}
              })
              .catch(function (err) {
                console.warn("[loadProject] hydrateProjectAssetUrls failed:", err);
              });
          })(_getProject());
          try { _ctx.syncEditProject && _ctx.syncEditProject(_getProject()); } catch (_) {}
          try { _ctx.syncTasksProject && _ctx.syncTasksProject(_getProject()); } catch (_) {}
          try { _ctx.ensureEpisodes && _ctx.ensureEpisodes(); } catch (_) {}
          try { cleanupBlobUrls(_getProject()); } catch (_) {}
          try { _ctx.addProjectToList && _ctx.addProjectToList(_getProject()); } catch (_) {}
        } else {
          console.warn("[loadProject] fetch current project failed, id=", targetId);
        }
      }
    } finally {
      // 关骨架屏放在 finally —— 不管上面出了什么妖蛾子（fetch reject、AbortError、
      // setProject 抛错），骨架屏都必须撤掉，绝不让用户卡在"正在从服务器同步项目"。
      if (_ctx.showProjectSkeleton) {
        try { _ctx.showProjectSkeleton(false); } catch (_) {}
      }
    }

    try { _ctx.resetProjectUI && _ctx.resetProjectUI(); } catch (_) {}
    try {
      if (_ctx.refreshActivePage) _ctx.refreshActivePage();
      else if (_ctx.refreshAllPages) _ctx.refreshAllPages();
    } catch (_) {}

    if (_getProject()) {
      try { _ctx.restoreAssetGenStatus && _ctx.restoreAssetGenStatus(); } catch (_) {}
      try { _ctx.restoreVideoTasks && _ctx.restoreVideoTasks(); } catch (_) {}
      if (_ctx.recoverTasksFromServer) {
        try { _ctx.recoverTasksFromServer(); } catch (_) {}
      }
    }
  }

  /**
   * Phase 5.9：`_syncProjectsFromServer` 已合并进 `loadProject` + `_serverSave`
   * 的 409 re-sync 分支。保留空实现只为维持模块出口兼容，调用即 no-op。
   */
  async function _syncProjectsFromServer() {
    // deprecated · kept as no-op to preserve module export shape.
  }

  /**
   * 纯 fetch 函数，无副作用：只按 id 从服务器拉项目数据并返回，失败返回 null。
   * 供素材库等"查看别的项目"场景复用，不会动全局 project 状态。
   */
  async function fetchProjectFromServer(projId) {
    if (!projId) return null;
    return fetchProjectByIdShared(projId);
  }

  /**
   * 统一入口：按 id 加载项目数据——只问服务器，别的项目一律不再本地缓存。
   *
   * Phase 3-B-10 起：后端 `project.json` 是唯一权威源，素材库 / 跨项目资产
   * 复用等"看别的项目"的只读场景直接透传服务器返回；失败就返回 null，不
   * 再从 `sw_proj_<id>` 读缓存——那份数据长期和服务器不对齐，刷新或换设备
   * 立刻失真（就是用户抱怨的"刷新丢人物丢图"的病根之一）。
   */
  async function loadProjectData(projId) {
    if (!projId) return null;
    var srv = await fetchProjectFromServer(projId);
    if (srv) {
      await hydrateProjectAssetUrls(srv);
      return srv;
    }
    return null;
  }

  /**
   * Phase 5.9：服务器权威 re-sync。用于 `_serverSave` 409 分支和其他需要
   * "放弃本地内存态、整体换成服务器最新"的场景。
   *
   * 旧实现拿 `updatedAt` 比"服务器是否更新"再决定要不要覆盖内存——`updatedAt`
   * 是毫秒时间戳，同一毫秒多次写、或后端只写单字段漏刷 updatedAt 都会让它
   * 失准；真正的权威是 `version`（`_write_project` 每次递增）。这里干脆
   * **无条件**用服务器返回的整包替换内存，不再做时间戳比较——走到这个函数
   * 的场景天然就是"服务器比我新"或"我不确定，需要强制对齐"。
   */
  async function _loadProjectFromServer(projId) {
    try {
      var serverProj = await fetchProjectFromServer(projId);
      if (!serverProj) return;
      _setProject(serverProj);
      _updateLegacyStoryboardArchiveEntry(serverProj);
      _maybeShowLegacyStoryboardArchiveNotice(serverProj);
      await hydrateProjectAssetUrls(_getProject());
      try { _ctx.syncEditProject && _ctx.syncEditProject(_getProject()); } catch (_) {}
      try { _ctx.syncTasksProject && _ctx.syncTasksProject(_getProject()); } catch (_) {}
      try { _ctx.ensureEpisodes && _ctx.ensureEpisodes(); } catch (_) {}
      // E-script/D：前端不再主动触发 tagEmotions。老项目「有剧本无情绪段」
      // 的自动补标改由后端 routers/project_api._maybe_backfill_emotions 在
      // GET /api/projects/{id} 时 fire-and-forget 派发，下一次加载即生效。
      cleanupBlobUrls(_getProject());
      try { _ctx.resetProjectUI && _ctx.resetProjectUI(); } catch (_) {}
      try { _ctx.refreshAllPages && _ctx.refreshAllPages(); } catch (_) {}
      try { _ctx.restoreVideoTasks && _ctx.restoreVideoTasks(); } catch (_) {}
      if (_ctx.recoverTasksFromServer) {
        try { _ctx.recoverTasksFromServer(); } catch (_) {}
      }
      console.log("[ServerSync] force-synced project from server, version=" + (serverProj.version || "?"));
    } catch (e) {
      console.warn("[ServerSync] load _getProject() failed:", e);
    }
  }

  function cleanupBlobUrls(proj) {
    function fixItem(item) {
      if (!item) return;
      if (item.imageUrl && item.imageUrl.indexOf("blob:") === 0) {
        item.imageUrl = item.rawUrl || "";
      }
      if (item.realPhotoUrl && item.realPhotoUrl.indexOf("blob:") === 0) {
        item.realPhotoUrl = "";
      }
      if (item.pencilUrl && item.pencilUrl.indexOf("blob:") === 0) {
        item.pencilUrl = "";
      }
    }
    if (proj.assets) {
      (proj.assets.characters || []).forEach(fixItem);
      (proj.assets.scenes || []).forEach(fixItem);
      (proj.assets.props || []).forEach(fixItem);
    }
    if (proj.storyboards) {
      proj.storyboards.forEach(function (sb) {
        fixItem(sb);
        if (sb && sb._vpCache) delete sb._vpCache;
        if (sb && sb._vpKey) delete sb._vpKey;
      });
    }
    if (proj.episodes) {
      proj.episodes.forEach(function (ep) {
        if (ep && ep.storyboards) {
          ep.storyboards.forEach(function (sb) {
            if (sb && sb._vpCache) delete sb._vpCache;
            if (sb && sb._vpKey) delete sb._vpKey;
          });
        }
      });
    }
  }

  var _serverSaveTimer = null;

  /* 序列化前剥离运行期缓存（如 storyboard._vpCache / _vpKey），
     防止把"前端临时解析结果"写回 localStorage / 服务器后变成永久性坏数据。 */
  function _serializeProject(proj) {
    return JSON.stringify(proj, function (key, value) {
      if (key === "_vpCache" || key === "_vpKey") return undefined;
      if (key.indexOf("_origin") === 0) return undefined;
      if (this && key === 'videoUrl' && typeof this._originVideoUrl !== 'undefined') return this._originVideoUrl;
      if (this && key === 'pencilUrl' && typeof this._originPencilUrl !== 'undefined') return this._originPencilUrl;
      if (this && key === 'realPhotoUrl' && typeof this._originRealPhotoUrl !== 'undefined') return this._originRealPhotoUrl;
      if (this && key === 'imageUrl' && typeof this._originImageUrl !== 'undefined') return this._originImageUrl;
      if (this && key === 'rawUrl' && typeof this._originRawUrl !== 'undefined') return this._originRawUrl;
      if (this && key === 'coverUrl' && typeof this._originCoverUrl !== 'undefined') return this._originCoverUrl;
      return value;
    });
  }

  function saveProject() {
    if (!_getProject()) return;
    if (_ctx.saveCurrentEpisode) _ctx.saveCurrentEpisode();
    // Phase 5.9：服务器是唯一权威源。彻底取消本地"当前项目完整快照"影子写入
    // （历史上是 `_STORAGE_PROJECT` / `sw_proj_<id>` 两份，都已废弃）。
    // 只记录"上次打开过哪个项目" 这一个轻量引用，供下次刷新直接 GET 同一个 id。
    try {
      var p = _getProject();
      if (p && p.id) localStorage.setItem(_LAST_PROJECT_ID_KEY(), p.id);
    } catch (_) {}
    _serverSave({ debounce: true });
  }

  /**
   * Phase 5.1 + 3-B-10：项目 PUT 统一入口。
   *
   * 选项：
   *   - `debounce: true` → 延迟 1500ms 合并后续编辑再真正 PUT（saveProject 路径）
   *   - `silent: true`   → 409 stale_version 时不弹 toast（后台静默同步用）
   *
   * 后端 app/api/projects/[id]/route.ts + lib/projects-db.ts::updateProjectForUser
   * 看到客户端 `If-Match: "v<version>"` 落后服务器时返回
   * 409 `{ error: "stale_version", serverVersion, clientVersion }`：
   *   - 不覆盖本地改动，让调用方决定后续（通常建议用户刷新）
   *   - 给个 toast 提示被其他 tab/设备改过
   * 没有 If-Match（老数据缺 version）时沿用旧行为（直接覆盖）。
   *
   * Phase 3-B-10：把原先的 `_debouncedServerSave` 小包装合并进来，唯一对外
   * 入口就是 `_serverSave` 和 `_flushServerSave`，语义更直。
   */
  function _serverSave(opts) {
    opts = opts || {};
    if (opts.debounce) {
      if (_serverSaveTimer) clearTimeout(_serverSaveTimer);
      return new Promise(function (resolve) {
        _serverSaveTimer = setTimeout(function () {
          _serverSaveTimer = null;
          _serverSave({ silent: opts.silent }).then(resolve);
        }, 1500);
      });
    }
    var proj = _getProject();
    if (!proj || !proj.id) return Promise.resolve({ ok: false, reason: "no-project" });
    var payload = _serializeProject(proj);
    var headers = Object.assign({}, _getAuthHeaders());
    // proj.version 可能缺省（老数据），缺省就不挂 If-Match，回退到旧覆盖语义。
    var clientVer = parseInt(proj.version, 10);
    if (!isNaN(clientVer) && clientVer >= 0) {
      headers["If-Match"] = "v" + clientVer;
    }
    return fetch("/api/projects/" + encodeURIComponent(proj.id), {
      method: "PUT",
      headers: headers,
      body: payload,
    }).then(function (resp) {
      if (resp.status === 409) {
        return resp.json().then(async function (j) {
          console.warn("[ServerSave] 409 stale_version:", j);
          // Phase 5.9：碰到 409 说明本地 version 已经落后于服务器（多半是
          // batch_runner 的 `apply_patch_and_save` 刚把资产结果直接写进了
          // project.json，而前端内存还没来得及吃 `task_completed` SSE 推回
          // 的 `serverVersion`）。旧实现只弹一条 toast，UI 继续停留在老
          // 版本 → 用户刷新后看到的是"图已经生成但前端没更新"的假死状态。
          //
          // 现在：无条件用服务器整包替换内存（see `_loadProjectFromServer`），
          // 后续的 refreshAllPages 会自动把新图、新分镜、新提示词铺到 UI。
          // 本次 PUT 丢弃，caller 不用自己重试——下一次 saveProject 会带着
          // 新 version 去 PUT。
          if (proj && proj.id) {
            try { await _loadProjectFromServer(proj.id); } catch (_) {}
          }
          if (!opts.silent) {
            showToast("已同步到服务器最新版本", "info");
          }
          return { ok: false, stale: true, serverVersion: j.serverVersion };
        });
      }
      if (!resp.ok) {
        console.warn("[ServerSave] non-2xx:", resp.status);
        return { ok: false, status: resp.status };
      }
      return resp.json().then(function (j) {
        // 服务器把新 version 挂在响应里 → 写回内存，为下次 PUT 带对齐的 If-Match
        var latest = _getProject();
        if (latest && latest.id === proj.id && j) {
          if (typeof j.version === "number") latest.version = j.version;
          if (typeof j.name === "string") latest.name = j.name;
          if (typeof j.title === "string") latest.title = j.title;
        }
        return { ok: true, version: j && j.version };
      });
    }).catch(function (e) {
      console.warn("[ServerSave] failed:", e);
      return { ok: false, error: e };
    });
  }

  /**
   * 立刻把当前项目同步刷到服务器（跳过 1.5s debounce）。
   *
   * 用于"一旦丢失就很贵"的关键落地点：
   *   - 角色真人图刚拿到 realPhotoUrl（单个重生 / Step1 完成）
   *   - 角色彩铅图刚拿到 pencilUrl（Step2 完成）
   *   - 分镜/视频一键生成完成后
   *   - Phase 5.2：切项目前 await 这条，保证 PUT 先落盘再 GET 新项目
   *
   * 返回 Promise，多数 caller 用 fire-and-forget；切项目路径必须 await。
   */
  function _flushServerSave() {
    if (_serverSaveTimer) {
      clearTimeout(_serverSaveTimer);
      _serverSaveTimer = null;
    }
    return _serverSave();
  }

  function flushPendingProjectSaveOnUnload() {
    var proj = _getProject();
    if (!proj || !proj.id || !_serverSaveTimer) return false;
    clearTimeout(_serverSaveTimer);
    _serverSaveTimer = null;
    try { if (_ctx.saveCurrentEpisode) _ctx.saveCurrentEpisode(); } catch (_) {}
    try {
      var headers = Object.assign({}, _getAuthHeaders());
      var clientVer = parseInt(proj.version, 10);
      if (!isNaN(clientVer) && clientVer >= 0) headers["If-Match"] = "v" + clientVer;
      fetch("/api/projects/" + encodeURIComponent(proj.id), {
        method: "PUT",
        headers: headers,
        body: _serializeProject(proj),
        keepalive: true,
      }).catch(function () {});
      return true;
    } catch (e) {
      console.warn("[ServerSave] unload keepalive failed:", e);
      return false;
    }
  }

  /**
   * Phase 5.3 · 5.4：_safeWriteBack 只服务"当前项目"这一种情况。
   *
   * 旧实现非当前项目时会写 `localStorage.sw_proj_<id>`，属于典型的前端影子
   * 持久化——和后端 project.json 长期不对齐，刷新/换设备立刻失真。现在：
   *   - `project.id === originId` → 在内存改 + saveProject()（含 debounce PUT）
   *   - 否则 → 明确拒绝，返回 false，由调用方放弃本次写入
   *     （异步回调的资产结果早就由 `services.project_patch.apply_patch_and_save`
   *      权威落盘到 project.json，不会真的丢）
   *
   * Phase 5.9：新增可选 `serverVersion` 参数。后端 `task_completed` SSE 里
   * 带回 `apply_patch_and_save` 刚落盘得到的新 version。前端调用
   * `_safeWriteBack(originId, fn, serverVersion)` 时会同步把内存 project.version
   * 推到 `max(当前, serverVersion)`，让后续 debounced PUT 的 `If-Match`
   * 贴齐服务器，消除"一键生成期间资产 executor 每落一条盘、前端下一次 PUT
   * 就 409"的恶性循环。
   */
  function _safeWriteBack(originId, writeFn, serverVersion) {
    var proj = _getProject();
    if (proj && proj.id === originId) {
      if (typeof serverVersion === "number" && serverVersion > 0) {
        var cur = (typeof proj.version === "number" && proj.version > 0) ? proj.version : 0;
        if (serverVersion > cur) proj.version = serverVersion;
      }
      writeFn(proj);
      saveProject();
      return true;
    }
    // 不再 fallback 写 localStorage：数据权威源是后端 project.json。
    return false;
  }

  /**
   * Before overwriting an image on an asset / storyboard / character item,
   * snapshot the old URLs into item.imageHistory so the user can roll back,
   * and so the Library view can surface old versions as reusable assets.
   *
   * Called in every place where we assign `.imageUrl = <new>` on a persistent
   * item. Safe to call even when the slot is still empty — it silently no-ops.
   * Max 10 snapshots per item; oldest gets dropped.
   */
  // 资产卡按类型扫的「信息字段表」——和后端 IMAGE_RELEVANT_FIELDS 一一对应。
  // 这些字段任一变化都意味着图片需要重生成，归档时把当前快照里的这些字段一起保存，
  // 后续从「历史记录」一键替换时可以一并还原。
  var _ASSET_INFO_FIELDS = {
    char: ["name","role","identity","appearance","clothing","equipment",
           "temperament","actionTraits","entityType","castingOverride",
           "imagePrompt","description","tags"],
    scene: ["name","description","location","timeSetting","weather","lighting",
            "atmosphere","elements","imagePrompt"],
    prop: ["name","propType","features","material","imagePrompt"],
  };

  function _captureItemInfo(item, source) {
    if (!item || typeof item !== "object") return null;
    // source 形如 "stylize" / "regen" / "restore" / "info_changed" 等，无法直接区分 char/scene/prop。
    // 用启发：char 卡才会有 appearance/clothing/equipment；scene 才会有 location/atmosphere；
    // 都没有就当 prop。
    var kind = "prop";
    if ("appearance" in item || "clothing" in item || "equipment" in item || "actionTraits" in item) kind = "char";
    else if ("location" in item || "atmosphere" in item || "timeSetting" in item) kind = "scene";
    var fields = _ASSET_INFO_FIELDS[kind];
    var info = {};
    // 全字段都记录（含 null/undefined），还原时能完整覆盖回去，避免"曾经为空但当前有值"的字段没被清空。
    fields.forEach(function (f) {
      info[f] = item[f] === undefined ? null : item[f];
    });
    return info;
  }

  function _canonicalStoryboardFirstFrameUrl(item) {
    if (!item || typeof item !== "object") return "";
    return (item.frames && item.frames.first && item.frames.first.url) ||
      item.firstFrameUrl ||
      (item.firstFrame && item.firstFrame.currentUrl) ||
      item.url ||
      item.imageUrl ||
      item.rawUrl ||
      "";
  }

  function _canonicalStoryboardFirstFrameRawUrl(item, canonicalUrl) {
    if (!item || typeof item !== "object") return "";
    return (item.firstFrame && item.firstFrame.rawUrl) ||
      item.rawUrl ||
      canonicalUrl ||
      "";
  }

  function _archiveOldImage(item, source) {
    if (!item || typeof item !== "object") return;
    var snap = {};
    if (source === "storyboard") {
      var canonicalUrl = _canonicalStoryboardFirstFrameUrl(item);
      var canonicalRawUrl = _canonicalStoryboardFirstFrameRawUrl(item, canonicalUrl);
      if (canonicalUrl) snap.url = canonicalUrl;
      if (canonicalRawUrl && canonicalRawUrl !== snap.url) snap.rawUrl = canonicalRawUrl;
    } else {
      if (item.imageUrl) snap.url = item.imageUrl;
      if (item.rawUrl && item.rawUrl !== snap.url) snap.rawUrl = item.rawUrl;
    }
    if (item.realPhotoUrl && item.realPhotoUrl !== snap.url) snap.realPhotoUrl = item.realPhotoUrl;
    if (item.pencilUrl) snap.pencilUrl = item.pencilUrl;
    if (!snap.url && !snap.rawUrl && !snap.realPhotoUrl && !snap.pencilUrl) return;
    var info = _captureItemInfo(item, source);
    if (info) snap.info = info;

    // Skip dead blob:// snapshots — they won't survive a page reload anyway.
    var mainUrl = snap.url || snap.rawUrl || snap.realPhotoUrl || snap.pencilUrl;
    if (typeof mainUrl === "string" && mainUrl.indexOf("blob:") === 0) return;

    snap.at = Date.now();
    snap.source = source || "";
    if (source === "storyboard") {
      var basePrompt = item.firstFrameBasePrompt && typeof item.firstFrameBasePrompt === "object"
        ? item.firstFrameBasePrompt.content
        : item.firstFrameBasePrompt;
      snap.mode = item.firstFrameMode || (item.frames && item.frames.first && item.frames.first.mode) || "";
      snap.sourceHash = item.firstFrameSourceHash || (item.frames && item.frames.first && item.frames.first.sourceHash) || null;
      snap.planSummary = item.firstFramePlanSummary || (item.frames && item.frames.first && item.frames.first.planSummary) || null;
      snap.firstFrameBasePrompt = String(basePrompt || item.originalFirstFramePrompt || (item.frames && item.frames.first && item.frames.first.originalPrompt) || "");
      snap.submittedPrompt = String(item.firstFramePrompt || (item.frames && item.frames.first && item.frames.first.prompt) || item.imagePrompt || "");
    }
    if (!Array.isArray(item.imageHistory)) item.imageHistory = [];
    // Dedup: if the incoming snap equals the current top, do nothing.
    var top = item.imageHistory[0];
    if (top && top.url === snap.url && top.rawUrl === snap.rawUrl &&
        top.pencilUrl === snap.pencilUrl && top.realPhotoUrl === snap.realPhotoUrl) {
      return;
    }
    item.imageHistory.unshift(snap);
    if (item.imageHistory.length > _MAX_IMAGE_HISTORY) {
      item.imageHistory.length = _MAX_IMAGE_HISTORY;
    }
  }

  /**
   * Produces the "历史(N)" button HTML fragment to be inlined alongside
   * "重新生成" in every card that may have archived previous versions.
   * Three style variants match existing button skins so layouts stay clean:
   *   - "pill-white": hero scene card (white round-icon style)
   *   - "pill-dark": character card (dark round pill)
   *   - "chip":      compact scene/prop card + storyboard card
   */

  function _notifyServerTaskDone(taskId) {
    apiPost("/api/tasks/" + encodeURIComponent(taskId) + "/status", { status: "done" }).catch(function () {});
  }

  function _registerServerTask(taskId, taskType, targetType, targetIdx, extra) {
    var proj = _getProject();
    if (!proj || !proj.id || !taskId) return;
    var body = {
      taskId: taskId,
      projectId: proj.id,
      taskType: taskType,
      targetType: targetType || "",
      targetIdx: targetIdx || 0,
    };
    if (extra) {
      var payloadExtra = {};
      if (extra._videoChannel) payloadExtra.videoChannel = extra._videoChannel;
      if (extra._videoAdapter) payloadExtra.videoAdapter = extra._videoAdapter;
      if (extra._discoveredPollPath) payloadExtra.pollTmpl = extra._discoveredPollPath;
      if (Object.keys(payloadExtra).length) body.extra = payloadExtra;
    }
    apiPost("/api/tasks/register", body).catch(function (e) {
      console.warn("[TaskReg] register failed:", e);
    });
  }

  function _updateServerTaskStatus(taskId, status, resultUrl, errorMsg, assetId, fetchStatus) {
    if (!taskId) return;
    var body = { status: status };
    if (status === 'failed' && typeof errorMsg !== 'undefined' && errorMsg !== null) body.errorMsg = errorMsg;
    apiPost("/api/tasks/" + encodeURIComponent(taskId) + "/status", body).catch(function () {});
  }

export function setProject(p) { _setProject(p); }
export { loadProject, saveProject, _serializeProject, cleanupBlobUrls,
  _registerServerTask, _updateServerTaskStatus, _notifyServerTaskDone,
  _syncProjectsFromServer, _loadProjectFromServer, _archiveOldImage, _safeWriteBack,
  _flushServerSave, flushPendingProjectSaveOnUnload,
  fetchProjectByIdShared, fetchProjectFromServer, loadProjectData };
