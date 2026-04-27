// ============================================================================
// holo_card.js
// ----------------------------------------------------------------------------
// 参考：https://reactbits.dev/components/profile-card （官方实现见
//   https://shadcnindex.com/components/react-bits/ProfileCard-JS-CSS 上的
//   ProfileCard.tsx + ProfileCard.css）。
// 这里用原生 ES Module 重写其中的 "tilt + sunpillar shine + radial glare"
// 三件套，挂在订阅套餐卡（.plan-card）上，只做视觉增强：
//   - 鼠标进入卡片后，pointer 在卡片上的位置写入 CSS 变量
//     --pointer-x / --pointer-y / --background-x / --background-y /
//     --pointer-from-center / --pointer-from-top / --pointer-from-left
//   - 同步把角度写进 --rotate-x / --rotate-y 驱动 transform: rotateX/rotateY
//   - --card-opacity 控制 shine / glare 的整体淡入淡出（0 = 休眠）
//   - requestAnimationFrame + 指数平滑（tau）让 tilt 过渡柔和，不是生硬的贴图
//
// 严格是前端表现层：不请求任何接口、不写任何业务状态、不参与支付流程。
// CTA <button> 的 click 事件继续由 billing.js 自己绑定（shine/glare 两层
// 的 pointer-events:none 已保证按钮可点）。
// ============================================================================

const ANIM = Object.freeze({
  INITIAL_DURATION: 1000,
  INITIAL_X_OFFSET: 60,
  INITIAL_Y_OFFSET: 50,
});

// 最大 tilt 角度（±度）。订阅支付语境下倾斜过大反而廉价，取 6°。
const MAX_ROTATE = 6;

function clamp(v, min = 0, max = 100) {
  return Math.min(Math.max(v, min), max);
}
function round(v, precision = 3) {
  return parseFloat(v.toFixed(precision));
}
function adjust(v, fMin, fMax, tMin, tMax) {
  return round(tMin + ((tMax - tMin) * (v - fMin)) / (fMax - fMin));
}

/**
 * mountHoloCard(el, opts?) → destroy()
 *
 * opts:
 *   maxRotate?: number   // 覆盖默认 ±6°
 *   keepTranslateY?: bool // 进 holo 后是否保留原 hover 的 translateY（默认否）
 */
export function mountHoloCard(el, opts = {}) {
  if (!el) return function noop() {};

  const maxRotate = Number(opts.maxRotate || MAX_ROTATE);
  el.classList.add("holo-host");

  // 注入叠加层（幂等；重复调用不会重复插入）
  // 三层顺序（DOM 顺序 = 渲染顺序，层级由 CSS z-index 控制）：
  //   1) .plan-holo-shine  —— 全幅 ambient 彩虹（低亮度）
  //   2) .plan-holo-logo   —— logo-mask 裁出的彩虹主视觉层（高亮度）
  //   3) .plan-holo-glare  —— 跟随 pointer 的冷白径向高光
  // 所有层都 pointer-events:none，CTA button 仍可点击。
  let shine = el.querySelector(":scope > .plan-holo-shine");
  if (!shine) {
    shine = document.createElement("div");
    shine.className = "plan-holo-shine";
    shine.setAttribute("aria-hidden", "true");
    el.appendChild(shine);
  }
  let logoLayer = el.querySelector(":scope > .plan-holo-logo");
  if (!logoLayer) {
    logoLayer = document.createElement("div");
    logoLayer.className = "plan-holo-logo";
    logoLayer.setAttribute("aria-hidden", "true");
    el.appendChild(logoLayer);
  }
  let glare = el.querySelector(":scope > .plan-holo-glare");
  if (!glare) {
    glare = document.createElement("div");
    glare.className = "plan-holo-glare";
    glare.setAttribute("aria-hidden", "true");
    el.appendChild(glare);
  }

  // rAF 平滑：targetX/Y 是鼠标当前像素坐标，currentX/Y 是动画追赶值
  let rafId = 0;
  let running = false;
  let lastTs = 0;
  let currentX = 0;
  let currentY = 0;
  let targetX = 0;
  let targetY = 0;
  const DEFAULT_TAU = 0.12; // 常态追赶
  const INITIAL_TAU = 0.55; // 进入后前 1s 慢速归位，营造"从远处落下"的感觉
  let initialUntil = 0;

  function setVarsFromXY(x, y) {
    const rect = el.getBoundingClientRect();
    const width = rect.width || 1;
    const height = rect.height || 1;
    const localX = x - rect.left;
    const localY = y - rect.top;
    const percentX = clamp((100 / width) * localX);
    const percentY = clamp((100 / height) * localY);
    const centerX = percentX - 50;
    const centerY = percentY - 50;
    el.style.setProperty("--pointer-x", percentX + "%");
    el.style.setProperty("--pointer-y", percentY + "%");
    el.style.setProperty("--background-x", adjust(percentX, 0, 100, 35, 65) + "%");
    el.style.setProperty("--background-y", adjust(percentY, 0, 100, 35, 65) + "%");
    el.style.setProperty(
      "--pointer-from-center",
      String(clamp(Math.hypot(percentY - 50, percentX - 50) / 50, 0, 1)),
    );
    el.style.setProperty("--pointer-from-top", String(percentY / 100));
    el.style.setProperty("--pointer-from-left", String(percentX / 100));
    // 注意 rotate 方向：上半部往里倾 → rotateX 为正；右半部往后倾 → rotateY 为负
    el.style.setProperty("--rotate-x", round((-centerY / 50) * maxRotate) + "deg");
    el.style.setProperty("--rotate-y", round((centerX / 50) * maxRotate) + "deg");
  }

  function tick(ts) {
    if (!running) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.max(0.001, (ts - lastTs) / 1000);
    lastTs = ts;
    const tau = ts < initialUntil ? INITIAL_TAU : DEFAULT_TAU;
    const alpha = 1 - Math.exp(-dt / tau);
    currentX += (targetX - currentX) * alpha;
    currentY += (targetY - currentY) * alpha;
    setVarsFromXY(currentX, currentY);
    // 接近目标 & 不在 active 状态时退出 rAF，省电
    const doneX = Math.abs(targetX - currentX) < 0.2;
    const doneY = Math.abs(targetY - currentY) < 0.2;
    if (!el.classList.contains("holo-active") && doneX && doneY && ts > initialUntil) {
      running = false;
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function startTick() {
    if (running) return;
    running = true;
    lastTs = 0;
    rafId = requestAnimationFrame(tick);
  }

  function onEnter(e) {
    el.classList.add("holo-active");
    el.style.setProperty("--card-opacity", "1");
    initialUntil = performance.now() + ANIM.INITIAL_DURATION;
    // 入场时给个从偏移到中心的动画（参考 ProfileCard 的 INITIAL_X/Y_OFFSET）
    const rect = el.getBoundingClientRect();
    currentX = rect.left + rect.width / 2 + ANIM.INITIAL_X_OFFSET;
    currentY = rect.top + rect.height / 2 + ANIM.INITIAL_Y_OFFSET;
    targetX = e ? e.clientX : rect.left + rect.width / 2;
    targetY = e ? e.clientY : rect.top + rect.height / 2;
    startTick();
  }
  function onMove(e) {
    targetX = e.clientX;
    targetY = e.clientY;
    if (!running) startTick();
  }
  function onLeave() {
    el.classList.remove("holo-active");
    el.style.setProperty("--card-opacity", "0");
    // 目标回到中心，rAF 会把 tilt 平滑归零再停机
    const rect = el.getBoundingClientRect();
    targetX = rect.left + rect.width / 2;
    targetY = rect.top + rect.height / 2;
    if (!running) startTick();
  }

  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerleave", onLeave);

  // 初始值
  el.style.setProperty("--card-opacity", "0");
  el.style.setProperty("--rotate-x", "0deg");
  el.style.setProperty("--rotate-y", "0deg");

  return function destroy() {
    running = false;
    if (rafId) {
      try { cancelAnimationFrame(rafId); } catch (_e) { /* noop */ }
      rafId = 0;
    }
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerleave", onLeave);
    el.classList.remove("holo-host", "holo-active");
    // 不移除已注入的 .plan-holo-shine / .plan-holo-glare，保持 DOM 幂等
  };
}
