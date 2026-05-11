/**
 * render_hooks.js — 统一卡片渲染钩子（Phase 3-A 打底）
 *
 * 资产卡 / 分镜卡 / VP 卡 三类卡片在 "loading / done / error" 三态下的
 * **DOM 级**增量渲染集中到这里。业务状态（_assetGenStatus /
 * project._generatingAssets / project.storyboards 等）依旧留在调用方模块，
 * render_hooks 只接受一个 payload，不直接读写 project。
 *
 * Phase 3-A 阶段：由旧的 updateAssetCardImage / updateStoryboardCard /
 * updateVpCard 内部引线调过来，不强迫所有调用方迁移；Phase 3-B/3-C 批量入口
 * 改造时，SSE onCompleted / onFailed 可以直接调这些 hook，不用再各自拼 DOM。
 *
 * 本模块故意写成"纯 DOM 操作 + 返回值说明容器是否存在"，调用方据此
 * 决定要不要置 `_pendingRerender`。
 */

import { $, escapeHtml, hydrateProtectedImageElements } from './utils.js';

// ---------------------------------------------------------------------------
// Asset card (角色/场景/道具)
// ---------------------------------------------------------------------------

/**
 * 更新资产卡图片状态。
 * @param {"char"|"scene"|"prop"} type
 * @param {number} idx
 * @param {"loading"|"done"|"error"} status
 * @param {{imgUrl?: string, loadingText?: string, errMsg?: string}} payload
 * @returns {{ok: boolean, needFullRerender?: boolean}}
 *   ok=false 表示 grid 容器不在页面上（用户切了 Tab），调用方应置
 *   `_pendingRerender` 等回到本页时再整体 re-render。
 */
export function renderAssetCard(type, idx, status, payload) {
  payload = payload || {};
  var gridId = type === "char" ? "assetCharGrid"
             : type === "scene" ? "assetSceneGrid"
             : "assetPropGrid";
  var container = $(gridId);
  if (!container) return { ok: false, needFullRerender: true };

  var card = container.querySelector('[data-type="' + type + '"][data-idx="' + idx + '"]');
  if (!card) return { ok: false };

  var loading = card.querySelector(".asset-card-loading");

  if (status === "loading") {
    if (loading) {
      loading.hidden = false;
      var span = loading.querySelector("span");
      if (span && payload.loadingText) span.textContent = payload.loadingText;
    }
    return { ok: true };
  }

  if (status === "done" && payload.imgUrl) {
    if (loading) loading.hidden = true;
    var updated = _updateCardImageInPlace(card, payload.imgUrl);
    return { ok: true, needFullRerender: !updated };
  }

  if (status === "error") {
    if (loading) loading.hidden = true;
    return { ok: true };
  }

  return { ok: true };
}


// ---------------------------------------------------------------------------
// Storyboard card (分镜组)
// ---------------------------------------------------------------------------

/**
 * 更新分镜组卡片状态。
 * @param {number} gIdx
 * @param {"loading"|"done"|"error"} status
 * @param {{imgUrl?: string, loadingText?: string, errMsg?: string}} payload
 *
 * 修 audit P0-4：done 时原先只关了 overlay 却没更新 <img src>，
 * 成功生成后卡片仍显示旧图/占位符，必须手动刷新才能看到新图。
 * 这里改成：done + 有 imgUrl 时调 _updateCardImageInPlace；若卡片原本
 * 是占位符（无 <img>），返回 needFullRerender=true 让调用方整体 re-render。
 */
export function renderStoryboardCard(gIdx, status, payload) {
  payload = payload || {};
  var grid = $("imageGrid");
  if (!grid) return { ok: false, needFullRerender: true };
  var card = grid.querySelector('[data-group-idx="' + gIdx + '"]');
  if (!card) return { ok: false };

  var loading = card.querySelector(".sb-sheet-loading");
  var error = card.querySelector(".sb-sheet-error");
  var loadingText = loading ? loading.querySelector("span") : null;

  if (status === "loading") {
    if (loading) loading.hidden = false;
    if (error) error.hidden = true;
    if (loadingText) loadingText.textContent = payload.loadingText || "生成中…";
    return { ok: true };
  }

  if (status === "done") {
    if (loading) loading.hidden = true;
    if (error) error.hidden = true;
    if (payload.imgUrl) {
      var firstFrame = card.querySelector('[data-frame="first"]');
      var updated = firstFrame
        ? _updateFrameImageInPlace(firstFrame, payload.imgUrl)
        : _updateCardImageInPlace(card, payload.imgUrl);
      return { ok: true, needFullRerender: !updated };
    }
    return { ok: true };
  }

  if (status === "error") {
    if (loading) loading.hidden = true;
    if (error) {
      error.hidden = false;
      // 新版错误卡片是个含图标 + 标题 + 详情 + 提示的多段结构，
      // 这里只往 .sb-error-msg 这个详情段写错误原因，其它段固定文案不动。
      var msgSpan = error.querySelector('.sb-error-msg');
      var msg = (payload.errMsg || "生成失败，请稍后重试").slice(0, 200);
      if (msgSpan) {
        msgSpan.textContent = msg;
      } else {
        // 兼容老结构：如果模板还是单段错误条，直接 textContent
        error.textContent = msg;
      }
    }
    return { ok: true };
  }

  return { ok: true };
}


// ---------------------------------------------------------------------------
// Storyboard frame card (first / tail frame - P2.5a.T3)
// ---------------------------------------------------------------------------

/**
 * 按 frame 类型增量更新分镜卡片内的 first/tail 两个独立图位。
 * 与旧 renderStoryboardCard 区别: 不遍历卡片所有 <img>, 只更新
 * [data-frame="first"|"tail"] 容器内的 img/data-img/loading/error,
 * 保证一张图更新不影响另一张。
 *
 * DOM 约定 (由 T4 的模板保证):
 *   <div data-frame="first"> ... <img|placeholder> ... <.sb-frame-loading> <.sb-frame-error> </div>
 *   <div data-frame="tail">  ... <img|placeholder> ... <.sb-frame-loading> <.sb-frame-error> </div>
 *
 * @param {number} gIdx
 * @param {"first"|"tail"} kind
 * @param {"loading"|"done"|"error"} status
 * @param {{imgUrl?: string, loadingText?: string, errMsg?: string}} payload
 * @returns {{ok: boolean, needFullRerender?: boolean}}
 */
export function renderStoryboardFrameCard(gIdx, kind, status, payload) {
  payload = payload || {};
  if (kind !== 'first' && kind !== 'tail') {
    console.warn('[render_hooks] renderStoryboardFrameCard: invalid kind', kind);
    return { ok: false };
  }
  var grid = $("imageGrid");
  if (!grid) return { ok: false, needFullRerender: true };
  var card = grid.querySelector('[data-group-idx="' + gIdx + '"]');
  if (!card) return { ok: false };

  var frame = card.querySelector('[data-frame="' + kind + '"]');
  if (!frame) {
    // T4 前的旧模板没有 data-frame 容器 — 让调用方触发整体 re-render,
    // 下次 grid render 时会拿到 T4 新模板。
    return { ok: false, needFullRerender: true };
  }

  var loading = frame.querySelector(".sb-frame-loading");
  var error = frame.querySelector(".sb-frame-error");
  var loadingText = loading ? loading.querySelector("span") : null;

  if (status === "loading") {
    if (loading) loading.hidden = false;
    if (error) error.hidden = true;
    if (loadingText) loadingText.textContent = payload.loadingText || "生成中…";
    return { ok: true };
  }

  if (status === "done") {
    if (loading) loading.hidden = true;
    if (error) error.hidden = true;
    if (payload.imgUrl) {
      var updated = _updateFrameImageInPlace(frame, payload.imgUrl);
      return { ok: true, needFullRerender: !updated };
    }
    return { ok: true };
  }

  if (status === "error") {
    if (loading) loading.hidden = true;
    if (error) {
      error.hidden = false;
      var msgSpan = error.querySelector('.sb-frame-error-msg');
      var msg = (payload.errMsg || "生成失败，请稍后重试").slice(0, 200);
      if (msgSpan) {
        msgSpan.textContent = msg;
      } else {
        error.textContent = msg;
      }
    }
    return { ok: true };
  }

  return { ok: true };
}

/**
 * 在一个 [data-frame] 容器内替换 img/placeholder 的 src/data-img, 不动兄弟容器。
 */
function _updateFrameImageInPlace(frame, imgUrl) {
  var img = frame.querySelector('img');
  if (!img) {
    var placeholder = frame.querySelector('.sb-frame-placeholder');
    if (!placeholder) return false;
    img = document.createElement('img');
    img.className = placeholder.dataset.imgClass || 'w-full h-full object-cover';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.action = 'lightbox';
    img.src = imgUrl;
    placeholder.replaceWith(img);
  } else {
    img.loading = img.loading || 'lazy';
    img.decoding = 'async';
    img.src = imgUrl;
  }
  var zoomEls = frame.querySelectorAll('[data-img]');
  for (var i = 0; i < zoomEls.length; i += 1) {
    zoomEls[i].dataset.img = imgUrl;
    hydrateProtectedImageElements(zoomEls[i]);
  }
  hydrateProtectedImageElements(img);
  return true;
}


// ---------------------------------------------------------------------------
// Video-prompt card (分镜组的视频提示词)
// ---------------------------------------------------------------------------

/**
 * 更新视频提示词卡片的 loading overlay（只负责 loading 占位显示）。
 * done / error 的实际渲染仍由 videoPrompts.js 自己的
 * renderVideoPromptList / _renderVpStoryboardFrames 控制——因为它们依赖
 * 该模块内部的 _vpSelectedGroup / project.storyboards 状态，搬到这里
 * 会制造更严重的跨模块耦合。本阶段只把 loading overlay 的 DOM 拼装集中
 * 到这里，Phase 3-B 再把 list 渲染也搬过来。
 *
 * @returns {{ok:boolean, delegateToOwner:boolean}}
 *   delegateToOwner=true 表示本 hook 只处理 loading；done / error
 *   调用方应继续调 videoPrompts 的 list render helper。
 */
export function renderVpCard(gIdx, status, payload) {
  payload = payload || {};

  if (status === "loading") {
    var list = $("videoPromptList");
    if (!list) return { ok: false };
    list.innerHTML =
      '<div class="bg-white/40 backdrop-blur-[40px] rounded-xl p-12 border-b-2 border-primary-fixed-dim/30 shadow-sm relative overflow-hidden flex flex-col items-center justify-center flex-grow min-h-[50vh]">' +
        '<div class="tc-spinner mb-4"></div>' +
        '<span class="text-lg text-primary/70 font-light tracking-tight">' +
          escapeHtml(payload.loadingText || "AI 分析图片与剧本中…") +
        '</span>' +
      '</div>';
    return { ok: true };
  }

  // done / error：具体内容渲染依赖 videoPrompts 内部状态，调用方继续负责
  return { ok: true, delegateToOwner: true };
}


// ---------------------------------------------------------------------------
// Shared DOM helper
// ---------------------------------------------------------------------------

/**
 * 就地更新卡片内所有 <img src> 和 [data-img]。如果分镜卡片还只有
 * placeholder，先原地替换成 <img>，避免首次出图时整块 grid 重建。
 */
function _updateCardImageInPlace(card, imgUrl) {
  var imgs = card.querySelectorAll("img");
  var zoomEls = card.querySelectorAll("[data-img]");

  if (!imgs.length) {
    var sbPlaceholder = card.querySelector(".sb-sheet-placeholder");
    if (sbPlaceholder) {
      var img = document.createElement("img");
      img.className = "w-full h-full object-cover scale-105 group-hover:scale-100 transition-transform duration-1000 ease-out cursor-pointer";
      img.dataset.action = "lightbox";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = imgUrl;
      sbPlaceholder.replaceWith(img);
      imgs = [img];
    } else {
      var assetPlaceholder = card.querySelector(".asset-card-placeholder");
      if (!assetPlaceholder) return false;
      var assetImg = document.createElement("img");
      assetImg.className = assetPlaceholder.dataset.imgClass || "w-full h-full object-cover";
      assetImg.loading = "lazy";
      assetImg.decoding = "async";
      assetImg.src = imgUrl;
      assetPlaceholder.replaceWith(assetImg);
      imgs = [assetImg];
    }
  }

  for (var i = 0; i < imgs.length; i++) {
    imgs[i].loading = imgs[i].loading || "lazy";
    imgs[i].decoding = "async";
    imgs[i].src = imgUrl;
    hydrateProtectedImageElements(imgs[i]);
  }
  for (var j = 0; j < zoomEls.length; j++) {
    zoomEls[j].dataset.img = imgUrl;
    hydrateProtectedImageElements(zoomEls[j]);
  }
  return true;
}
