/**
 * PixelCard —— reactbits PixelCard 的原生 ES module 移植版。
 * 仅前端视觉，不调任何后端 API、不触业务状态；唯一职责是把一个已存在的容器元素
 * 加上 hover / focus 驱动的 canvas 像素闪烁动画。
 *
 * 源实现参考 reactbits PixelCard.jsx + PixelCard.css：鼠标进入时从中心向外按距离
 * 延迟 `appear`（像素块从 0 放大到 maxSize），到达后进入 `shimmer`（反复缩放）；
 * 鼠标离开 / blur 时 `disappear`（缩回 0，allIdle 后停止 rAF）。
 *
 * 使用：
 *   const destroy = mountPixelCard(document.getElementById('navBillingWrap'), {
 *     variant: 'blue',  // 可选 'default' | 'blue' | 'yellow' | 'pink'
 *     // gap / speed / colors / noFocus 均可覆盖对应 variant 的默认值
 *   });
 *   // destroy() 取消动画 + 解绑监听 + 释放 ResizeObserver，用于热替换或卸载场景
 *
 * 约束：调用前请确保 container 里已经有一个 <canvas class="pixel-canvas"></canvas>
 * 子节点（或允许本模块自动插入）；container 自身需声明 position:relative/absolute
 * 并 overflow:hidden，建议通过 CSS .pixel-card 类统一（见 static/styles.css）。
 */

class Pixel {
  constructor(canvas, context, x, y, color, speed, delay) {
    this.width = canvas.width;
    this.height = canvas.height;
    this.ctx = context;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = this.getRandomValue(0.1, 0.9) * speed;
    this.size = 0;
    this.sizeStep = Math.random() * 0.4;
    this.minSize = 0.5;
    this.maxSizeInteger = 2;
    this.maxSize = this.getRandomValue(this.minSize, this.maxSizeInteger);
    this.delay = delay;
    this.counter = 0;
    this.counterStep = Math.random() * 4 + (this.width + this.height) * 0.01;
    this.isIdle = false;
    this.isReverse = false;
    this.isShimmer = false;
  }

  getRandomValue(min, max) {
    return Math.random() * (max - min) + min;
  }

  draw() {
    const centerOffset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    this.ctx.fillStyle = this.color;
    this.ctx.fillRect(this.x + centerOffset, this.y + centerOffset, this.size, this.size);
  }

  appear() {
    this.isIdle = false;
    if (this.counter <= this.delay) {
      this.counter += this.counterStep;
      return;
    }
    if (this.size >= this.maxSize) {
      this.isShimmer = true;
    }
    if (this.isShimmer) {
      this.shimmer();
    } else {
      this.size += this.sizeStep;
    }
    this.draw();
  }

  disappear() {
    this.isShimmer = false;
    this.counter = 0;
    if (this.size <= 0) {
      this.isIdle = true;
      return;
    } else {
      this.size -= 0.1;
    }
    this.draw();
  }

  shimmer() {
    if (this.size >= this.maxSize) {
      this.isReverse = true;
    } else if (this.size <= this.minSize) {
      this.isReverse = false;
    }
    if (this.isReverse) {
      this.size -= this.speed;
    } else {
      this.size += this.speed;
    }
  }
}

function getEffectiveSpeed(value, reducedMotion) {
  const min = 0;
  const max = 100;
  const throttle = 0.001;
  const parsed = parseInt(value, 10);
  if (parsed <= min || reducedMotion) return min;
  if (parsed >= max) return max * throttle;
  return parsed * throttle;
}

const VARIANTS = {
  default: {
    activeColor: null,
    gap: 5,
    speed: 35,
    colors: '#f8fafc,#f1f5f9,#cbd5e1',
    noFocus: false,
  },
  blue: {
    activeColor: '#e0f2fe',
    gap: 10,
    speed: 25,
    colors: '#e0f2fe,#7dd3fc,#0ea5e9',
    noFocus: false,
  },
  yellow: {
    activeColor: '#fef08a',
    gap: 3,
    speed: 20,
    colors: '#fef08a,#fde047,#eab308',
    noFocus: false,
  },
  pink: {
    activeColor: '#fecdd3',
    gap: 6,
    speed: 80,
    colors: '#fecdd3,#fda4af,#e11d48',
    noFocus: true,
  },
};

export function mountPixelCard(container, options) {
  if (!container) return function noop() {};
  const opts = options || {};

  let canvas = container.querySelector('canvas.pixel-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'pixel-canvas';
    container.insertBefore(canvas, container.firstChild);
  }

  const variantName = opts.variant || 'default';
  const cfg = VARIANTS[variantName] || VARIANTS.default;
  const finalGap = opts.gap != null ? opts.gap : cfg.gap;
  const finalSpeed = opts.speed != null ? opts.speed : cfg.speed;
  const finalColors = opts.colors != null ? opts.colors : cfg.colors;
  const finalNoFocus = opts.noFocus != null ? opts.noFocus : cfg.noFocus;

  let reducedMotion = false;
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_e) {}

  let pixels = [];
  let rafId = null;
  let timePrevious = performance.now();

  function initPixels() {
    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = width;
    canvas.height = height;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    const colorsArray = String(finalColors).split(',');
    const gapPx = parseInt(finalGap, 10) || 5;
    const effSpeed = getEffectiveSpeed(finalSpeed, reducedMotion);
    const pxs = [];
    for (let x = 0; x < width; x += gapPx) {
      for (let y = 0; y < height; y += gapPx) {
        const color = colorsArray[Math.floor(Math.random() * colorsArray.length)];
        const dx = x - width / 2;
        const dy = y - height / 2;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const delay = reducedMotion ? 0 : distance;
        pxs.push(new Pixel(canvas, ctx, x, y, color, effSpeed, delay));
      }
    }
    pixels = pxs;
  }

  function doAnimate(fnName) {
    rafId = requestAnimationFrame(function () { doAnimate(fnName); });
    const timeNow = performance.now();
    const timePassed = timeNow - timePrevious;
    const timeInterval = 1000 / 60;
    if (timePassed < timeInterval) return;
    timePrevious = timeNow - (timePassed % timeInterval);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let allIdle = true;
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i];
      p[fnName]();
      if (!p.isIdle) allIdle = false;
    }
    if (allIdle) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function handleAnimation(name) {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(function () { doAnimate(name); });
  }

  function onEnter() { handleAnimation('appear'); }
  function onLeave() { handleAnimation('disappear'); }
  function onFocusIn(e) {
    if (e && e.relatedTarget && container.contains(e.relatedTarget)) return;
    handleAnimation('appear');
  }
  function onFocusOut(e) {
    if (e && e.relatedTarget && container.contains(e.relatedTarget)) return;
    handleAnimation('disappear');
  }

  container.addEventListener('mouseenter', onEnter);
  container.addEventListener('mouseleave', onLeave);
  if (!finalNoFocus) {
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
  }

  initPixels();
  let ro = null;
  try {
    ro = new ResizeObserver(function () { initPixels(); });
    ro.observe(container);
  } catch (_e) {
    // 老浏览器兜底：窗口 resize 时重算
    window.addEventListener('resize', initPixels);
  }

  return function destroy() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    if (ro) ro.disconnect();
    else window.removeEventListener('resize', initPixels);
    container.removeEventListener('mouseenter', onEnter);
    container.removeEventListener('mouseleave', onLeave);
    if (!finalNoFocus) {
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
    }
  };
}
