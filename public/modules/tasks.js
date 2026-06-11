/**
 * Maintenance Banner — extracted from main.js (stage 3 refactor).
 */
import { showToast } from '/modules/utils.js';

export function initTasks(_ctx) {}
export function syncTasksProject(_project) {}

  /* ═══════════════════════════════════════════════════════════════
   *  Maintenance Banner — polled every 10s, soft-blocks new jobs
   *  when a deploy is imminent (remaining < 30s).
   * ═══════════════════════════════════════════════════════════════ */

  var _maintBanner = {
    enabled: false,
    message: "",
    expiresAt: 0,
    interval: null,
    tickInterval: null,
    lastToastAt: 0,
  };

  async function checkMaintenanceBanner() {
    try {
      // Public endpoint, no Authorization needed.
      var resp = await fetch("/api/maintenance/banner", { cache: "no-store" });
      if (!resp.ok) return;
      var data = await resp.json();
      _maintBanner.enabled = !!(data && data.enabled);
      _maintBanner.message = (data && data.message) || "";
      _maintBanner.expiresAt = (data && data.expiresAt) || 0;
      _renderMaintBanner();
    } catch (e) { /* silent */ }
  }

  function _maintRemainingSeconds() {
    if (!_maintBanner.enabled || !_maintBanner.expiresAt) return 0;
    return Math.max(0, _maintBanner.expiresAt - Math.floor(Date.now() / 1000));
  }

  function _renderMaintBanner() {
    var el = document.getElementById("maintenanceBanner");
    if (!el) return;

    var remaining = _maintRemainingSeconds();
    if (!_maintBanner.enabled || (_maintBanner.expiresAt > 0 && remaining === 0)) {
      el.hidden = true;
      document.body.classList.remove("has-maint-banner");
      if (_maintBanner.tickInterval) {
        clearInterval(_maintBanner.tickInterval);
        _maintBanner.tickInterval = null;
      }
      return;
    }

    el.hidden = false;
    document.body.classList.add("has-maint-banner");
    var msgEl = el.querySelector(".mb-msg");
    var cntEl = el.querySelector(".mb-count");
    if (msgEl) msgEl.textContent = _maintBanner.message || "系统即将升级维护，请稍后再开始新任务";
    if (cntEl) {
      if (remaining > 0) {
        var m = Math.floor(remaining / 60);
        var s = remaining % 60;
        cntEl.textContent = m > 0
          ? (m + "分" + (s < 10 ? "0" + s : s) + "秒后开始")
          : (s + "秒后开始");
        cntEl.hidden = false;
      } else {
        cntEl.hidden = true;
      }
    }
    if (remaining > 0 && remaining <= 30) el.classList.add("mb-urgent");
    else el.classList.remove("mb-urgent");

    if (!_maintBanner.tickInterval && _maintBanner.expiresAt > 0) {
      _maintBanner.tickInterval = setInterval(_renderMaintBanner, 1000);
    }
  }

  /**
   * Soft-block callable — invoke before starting any potentially expensive
   * job (video/image generation, export, etc.). Returns true when the caller
   * should proceed, false when it should abort.
   */
  window.maintenanceSoftBlock = function maintenanceSoftBlock() {
    var remaining = _maintRemainingSeconds();
    if (!_maintBanner.enabled || remaining <= 0 || remaining > 30) return true;
    var now = Date.now();
    if (now - _maintBanner.lastToastAt > 3000) {
      _maintBanner.lastToastAt = now;
      try { showToast("系统 " + remaining + " 秒后维护，请稍后再试", "warn"); } catch (e) {}
    }
    return false;
  };

  function _startMaintenanceBannerPoll() {
    if (_maintBanner.interval) return;
    checkMaintenanceBanner();
    _maintBanner.interval = setInterval(checkMaintenanceBanner, 10000);
  }


export { _startMaintenanceBannerPoll, checkMaintenanceBanner };
