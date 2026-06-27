const K_MIN = 0.05;
const K_MAX = 2.5;
const DEFAULT_BUFFER = 640;

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampScale(scale, min = K_MIN, max = K_MAX) {
  const k = finiteNumber(scale, 1);
  return Math.max(min, Math.min(max, k));
}

export function normalizeTransform(transform) {
  const source = transform || {};
  return {
    k: clampScale(source.k == null ? 1 : source.k),
    x: finiteNumber(source.x, 0),
    y: finiteNumber(source.y, 0),
  };
}

export function worldToScreenPoint(point, transform) {
  const t = normalizeTransform(transform);
  return {
    x: finiteNumber(point && point.x, 0) * t.k + t.x,
    y: finiteNumber(point && point.y, 0) * t.k + t.y,
  };
}

export function screenToWorldPoint(point, transform) {
  const t = normalizeTransform(transform);
  return {
    x: (finiteNumber(point && point.x, 0) - t.x) / t.k,
    y: (finiteNumber(point && point.y, 0) - t.y) / t.k,
  };
}

export function zoomTransformAt(transform, screenPoint, nextScale) {
  const t0 = normalizeTransform(transform);
  const k1 = clampScale(nextScale);
  const c = {
    x: finiteNumber(screenPoint && screenPoint.x, 0),
    y: finiteNumber(screenPoint && screenPoint.y, 0),
  };
  const ratio = k1 / t0.k;
  return {
    k: k1,
    x: c.x - (c.x - t0.x) * ratio,
    y: c.y - (c.y - t0.y) * ratio,
  };
}

export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectToScreen(rect, transform) {
  const t = normalizeTransform(transform);
  const x = finiteNumber(rect && rect.x, 0);
  const y = finiteNumber(rect && rect.y, 0);
  const w = Math.max(0, finiteNumber(rect && rect.w, 0));
  const h = Math.max(0, finiteNumber(rect && rect.h, 0));
  return { x: x * t.k + t.x, y: y * t.k + t.y, w: w * t.k, h: h * t.k };
}

export function unionRects(rects) {
  const list = (Array.isArray(rects) ? rects : []).filter((rect) => rect && rect.w >= 0 && rect.h >= 0);
  if (!list.length) return { x: 0, y: 0, w: 1, h: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  list.forEach((rect) => {
    const x = finiteNumber(rect.x, 0);
    const y = finiteNumber(rect.y, 0);
    const w = Math.max(0, finiteNumber(rect.w, 0));
    const h = Math.max(0, finiteNumber(rect.h, 0));
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  });
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

export function fitTransformToRect(rect, viewport, options = {}) {
  const vw = Math.max(1, finiteNumber(viewport && viewport.w, 1));
  const vh = Math.max(1, finiteNumber(viewport && viewport.h, 1));
  const paddingRatio = finiteNumber(options.paddingRatio, 0.9);
  const bbox = {
    x: finiteNumber(rect && rect.x, 0),
    y: finiteNumber(rect && rect.y, 0),
    w: Math.max(1, finiteNumber(rect && rect.w, 1)),
    h: Math.max(1, finiteNumber(rect && rect.h, 1)),
  };
  const k = clampScale(Math.min(vw / bbox.w, vh / bbox.h) * paddingRatio);
  return {
    k,
    x: (vw - bbox.w * k) / 2 - bbox.x * k,
    y: (vh - bbox.h * k) / 2 - bbox.y * k,
  };
}

function viewportSize(rootEl) {
  if (!rootEl) return { w: 1, h: 1 };
  const rect = rootEl.getBoundingClientRect ? rootEl.getBoundingClientRect() : null;
  return {
    w: Math.max(1, finiteNumber((rect && rect.width) || rootEl.clientWidth, 1)),
    h: Math.max(1, finiteNumber((rect && rect.height) || rootEl.clientHeight, 1)),
  };
}

function relativePoint(rootEl, event) {
  const rect = rootEl && rootEl.getBoundingClientRect ? rootEl.getBoundingClientRect() : { left: 0, top: 0 };
  return {
    x: finiteNumber(event && event.clientX, 0) - finiteNumber(rect.left, 0),
    y: finiteNumber(event && event.clientY, 0) - finiteNumber(rect.top, 0),
  };
}

function isEditableTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function edgePath(source, target) {
  const x0 = source.x + source.w;
  const y0 = source.y + source.h / 2;
  const x1 = target.x;
  const y1 = target.y + target.h / 2;
  const dx = Math.max(80, Math.abs(x1 - x0) * 0.45);
  return {
    d: `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`,
    bbox: unionRects([
      { x: Math.min(x0, x1) - dx, y: Math.min(y0, y1) - 8, w: Math.abs(x1 - x0) + dx * 2, h: Math.abs(y1 - y0) + 16 },
    ]),
  };
}

export function createViewport(rootEl, options = {}) {
  if (!rootEl) throw new Error('createViewport requires rootEl');
  const worldEl = options.worldEl;
  const edgesSvgEl = options.edgesSvgEl;
  if (!worldEl) throw new Error('createViewport requires worldEl');
  if (!edgesSvgEl) throw new Error('createViewport requires edgesSvgEl');

  const nodes = new Map();
  const edgeRecords = [];
  let transform = normalizeTransform(options.initialTransform);
  let rafId = 0;
  let destroyed = false;
  let selectedId = '';
  let panning = null;
  let spaceDown = false;
  let handMode = false;

  worldEl.style.transformOrigin = '0 0';
  worldEl.style.willChange = 'transform';
  if (!rootEl.hasAttribute('tabindex')) rootEl.tabIndex = 0;

  function emitChange() {
    if (typeof options.onViewportChange === 'function') {
      options.onViewportChange({ ...transform });
    }
  }

  function applyNow() {
    rafId = 0;
    if (destroyed) return;
    worldEl.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;
    rootEl.style.setProperty('--board-scale', String(transform.k));
    refreshCulling();
    emitChange();
  }

  function scheduleApply() {
    if (rafId) return;
    rafId = requestAnimationFrame(applyNow);
  }

  function setTransform(next, opts = {}) {
    transform = normalizeTransform(next);
    if (opts.immediate) applyNow();
    else scheduleApply();
  }

  function getNodeRects(filterIds) {
    const ids = filterIds && filterIds.length ? new Set(filterIds) : null;
    const rects = [];
    nodes.forEach((node, id) => {
      if (!ids || ids.has(id)) rects.push({ x: node.x, y: node.y, w: node.w, h: node.h });
    });
    return rects;
  }

  function fit(ids) {
    const rects = getNodeRects(Array.isArray(ids) ? ids : null);
    if (!rects.length) return;
    setTransform(fitTransformToRect(unionRects(rects), viewportSize(rootEl)));
  }

  function zoomTo(scale, screenPoint) {
    const point = screenPoint || { x: viewportSize(rootEl).w / 2, y: viewportSize(rootEl).h / 2 };
    setTransform(zoomTransformAt(transform, point, scale));
  }

  function zoomBy(factor, screenPoint) {
    zoomTo(transform.k * finiteNumber(factor, 1), screenPoint);
  }

  function zoomToSelection() {
    if (selectedId && nodes.has(selectedId)) fit([selectedId]);
    else fit();
  }

  function setSelected(id) {
    selectedId = id && nodes.has(id) ? String(id) : '';
    nodes.forEach((node, nodeId) => {
      node.el.classList.toggle('is-selected', !!selectedId && nodeId === selectedId);
    });
  }

  function mountNode(id, el, rect) {
    if (!id || !el) return;
    const node = {
      el,
      x: finiteNumber(rect && rect.x, 0),
      y: finiteNumber(rect && rect.y, 0),
      w: Math.max(1, finiteNumber(rect && rect.w, 1)),
      h: Math.max(1, finiteNumber(rect && rect.h, 1)),
    };
    el.dataset.boardNodeId = String(id);
    el.style.position = 'absolute';
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.w}px`;
    el.style.minHeight = `${node.h}px`;
    nodes.set(String(id), node);
    setSelected(selectedId);
  }

  function updateNode(id, rect) {
    const node = nodes.get(String(id));
    if (!node) return;
    node.x = finiteNumber(rect && rect.x, node.x);
    node.y = finiteNumber(rect && rect.y, node.y);
    node.w = Math.max(1, finiteNumber(rect && rect.w, node.w));
    node.h = Math.max(1, finiteNumber(rect && rect.h, node.h));
    node.el.style.left = `${node.x}px`;
    node.el.style.top = `${node.y}px`;
    node.el.style.width = `${node.w}px`;
    node.el.style.minHeight = `${node.h}px`;
  }

  function removeNode(id) {
    const key = String(id);
    const node = nodes.get(key);
    if (node && node.el && node.el.remove) node.el.remove();
    nodes.delete(key);
    if (selectedId === key) selectedId = '';
  }

  function setEdges(edges) {
    edgeRecords.length = 0;
    edgesSvgEl.replaceChildren();
    (Array.isArray(edges) ? edges : []).forEach((edge) => {
      const from = nodes.get(String(edge && edge.from));
      const to = nodes.get(String(edge && edge.to));
      if (!from || !to) return;
      const pathInfo = edgePath(from, to);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathInfo.d);
      path.setAttribute('fill', 'none');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.dataset.boardEdge = `${edge.from || ''}->${edge.to || ''}`;
      edgesSvgEl.appendChild(path);
      edgeRecords.push({ path, bbox: pathInfo.bbox });
    });
    refreshCulling();
  }

  function refreshCulling() {
    const buffer = finiteNumber(options.cullBuffer, DEFAULT_BUFFER);
    const size = viewportSize(rootEl);
    const view = { x: -buffer, y: -buffer, w: size.w + buffer * 2, h: size.h + buffer * 2 };
    nodes.forEach((node) => {
      const visible = rectsIntersect(rectToScreen(node, transform), view);
      node.el.hidden = !visible;
    });
    edgeRecords.forEach((record) => {
      const visible = rectsIntersect(rectToScreen(record.bbox, transform), view);
      record.path.toggleAttribute('hidden', !visible);
    });
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const target = event.target;
    const onNode = target && target.closest && target.closest('[data-board-node-id]');
    const onControl = target && target.closest && target.closest('[data-board-control]');
    if ((onNode && !spaceDown && !handMode) || onControl) return;
    panning = {
      pointerId: event.pointerId,
      x0: finiteNumber(event.clientX, 0),
      y0: finiteNumber(event.clientY, 0),
      tx: transform.x,
      ty: transform.y,
    };
    rootEl.classList.add('is-panning');
    if (rootEl.setPointerCapture) rootEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!panning || event.pointerId !== panning.pointerId) return;
    setTransform({
      ...transform,
      x: panning.tx + finiteNumber(event.clientX, 0) - panning.x0,
      y: panning.ty + finiteNumber(event.clientY, 0) - panning.y0,
    });
  }

  function finishPan(event) {
    if (!panning || event.pointerId !== panning.pointerId) return;
    if (rootEl.releasePointerCapture) {
      try { rootEl.releasePointerCapture(event.pointerId); } catch (_) {}
    }
    panning = null;
    rootEl.classList.remove('is-panning');
  }

  function onWheel(event) {
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey) {
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomBy(factor, relativePoint(rootEl, event));
    } else {
      setTransform({ ...transform, x: transform.x - finiteNumber(event.deltaX, 0), y: transform.y - finiteNumber(event.deltaY, 0) });
    }
    event.preventDefault();
  }

  function onKeyDown(event) {
    if (isEditableTarget(event.target)) return;
    if (event.code === 'Space') {
      spaceDown = true;
      rootEl.classList.add('is-hand-active');
      event.preventDefault();
      return;
    }
    const center = { x: viewportSize(rootEl).w / 2, y: viewportSize(rootEl).h / 2 };
    if (event.key === '+' || event.key === '=') {
      zoomBy(1.1, center);
      event.preventDefault();
    } else if (event.key === '-') {
      zoomBy(1 / 1.1, center);
      event.preventDefault();
    } else if (event.key === '0') {
      zoomTo(1, center);
      event.preventDefault();
    } else if (event.shiftKey && event.code === 'Digit1') {
      fit();
      event.preventDefault();
    } else if (event.shiftKey && event.code === 'Digit2') {
      zoomToSelection();
      event.preventDefault();
    } else if (event.key === 'Escape') {
      setSelected('');
      if (typeof options.onEscape === 'function') options.onEscape();
    }
  }

  function onKeyUp(event) {
    if (event.code === 'Space') {
      spaceDown = false;
      rootEl.classList.remove('is-hand-active');
      event.preventDefault();
    }
  }

  rootEl.addEventListener('pointerdown', onPointerDown);
  rootEl.addEventListener('pointermove', onPointerMove);
  rootEl.addEventListener('pointerup', finishPan);
  rootEl.addEventListener('pointercancel', finishPan);
  rootEl.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  applyNow();

  return {
    setTransform,
    getTransform: () => ({ ...transform }),
    fit,
    zoomTo,
    zoomBy,
    zoomToSelection,
    screenToWorld: (x, y) => screenToWorldPoint({ x, y }, transform),
    worldToScreen: (x, y) => worldToScreenPoint({ x, y }, transform),
    mountNode,
    updateNode,
    removeNode,
    setEdges,
    setSelected,
    setHandMode(active) {
      handMode = !!active;
      rootEl.classList.toggle('is-hand-active', handMode || spaceDown);
    },
    refreshCulling,
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rootEl.removeEventListener('pointerdown', onPointerDown);
      rootEl.removeEventListener('pointermove', onPointerMove);
      rootEl.removeEventListener('pointerup', finishPan);
      rootEl.removeEventListener('pointercancel', finishPan);
      rootEl.removeEventListener('wheel', onWheel);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    },
  };
}
