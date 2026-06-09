/**
 * 统一页面内加载层控制器（Phase 0：assets / shots / batch / edit）。
 *
 * - 4 个页容器内的 `.sw-page-loading[data-loading-for]` 静态节点默认可见，
 *   解决 JS-ready 前的预启动闪屏；本控制器只负责显隐 / 切错误态。
 * - 由 main.js 的权威态（_swLoad / _swLoadToken）驱动，本模块不持有业务状态。
 * - 另提供区域 loader（showRegion/hideRegion），片段列表 prefetch 期间用，
 *   挂在外层 relative 容器（.batch-workbench-scroll），不进 #batchClipList。
 * - 纯 DOM，零依赖。
 */

var PIXEL_O =
  '<div class="sw-pixel-o" aria-hidden="true">' +
  '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>' +
  '</div>';
var LOAD_BODY = PIXEL_O + '<span class="sw-load-text">加载中…</span>';

export function createSwLoading(opts) {
  opts = opts || {};
  var pages = opts.pages || [];

  function overlayFor(page) {
    return document.querySelector('.sw-page-loading[data-loading-for="' + page + '"]');
  }
  function eachOverlay(fn) {
    pages.forEach(function (p) {
      var el = overlayFor(p);
      if (el) fn(el, p);
    });
  }
  function ensureBody(el) {
    var body = el.querySelector('.sw-load-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'sw-load-body';
      body.innerHTML = LOAD_BODY;
      el.insertBefore(body, el.firstChild);
    }
    return body;
  }

  function showOne(el) {
    el.removeAttribute('hidden');
    el.classList.remove('is-hiding');
    var body = ensureBody(el);
    body.hidden = false;
    var err = el.querySelector('.sw-load-error');
    if (err) err.hidden = true;
  }

  function hideOne(el) {
    el.classList.add('is-hiding');
    var done = function () {
      // 若期间又进入 loading（移除了 is-hiding），则不隐藏。
      if (el.classList.contains('is-hiding')) el.setAttribute('hidden', '');
      el.removeEventListener('transitionend', done);
    };
    el.addEventListener('transitionend', done);
    setTimeout(done, 260); // 兜底：transition 未触发也能收尾
  }

  function errorOne(el, onRetry) {
    el.removeAttribute('hidden');
    el.classList.remove('is-hiding');
    var body = el.querySelector('.sw-load-body');
    if (body) body.hidden = true;
    var err = el.querySelector('.sw-load-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'sw-load-error';
      err.innerHTML =
        '<span class="sw-load-text">加载失败</span>' +
        '<button type="button" class="sw-load-retry">重试</button>';
      el.appendChild(err);
    }
    err.hidden = false;
    var btn = err.querySelector('.sw-load-retry');
    if (btn) {
      btn.onclick = function () {
        if (typeof onRetry === 'function') onRetry();
      };
    }
  }

  function showRegion(host) {
    if (!host) return;
    var r = host.__swRegion;
    if (!r || !r.isConnected) {
      r = document.createElement('div');
      r.className = 'sw-region-loading';
      r.setAttribute('role', 'status');
      r.setAttribute('aria-live', 'polite');
      r.innerHTML = LOAD_BODY;
      host.appendChild(r);
      host.__swRegion = r;
    }
    r.hidden = false;
  }
  function hideRegion(host) {
    if (!host) return;
    if (host.__swRegion) host.__swRegion.hidden = true;
  }

  return {
    showAll: function () { eachOverlay(showOne); },
    hideAll: function () { eachOverlay(hideOne); },
    errorAll: function (onRetry) { eachOverlay(function (el) { errorOne(el, onRetry); }); },
    showRegion: showRegion,
    hideRegion: hideRegion,
  };
}
