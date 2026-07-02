import { assertModuleSingleton } from '/modules/module_singleton_guard.js';
import { $, escapeHtml, getActiveBatchesShared, showToast } from '/modules/utils.js';
import {
  ANGLES,
  CAMERA_MOVES,
  COMPOSITION_PRESETS,
  FOCUS_OPTIONS,
  LENSES,
  LIGHT_PRESETS,
  SHOT_TYPES,
} from '/modules/shotSchema.js';
import {
  _applyShotFieldValue,
  _buildDurationOptions,
  _buildPaceOptions,
  _buildSelectOptions,
  _shotFieldCurrent,
  _swapAdjacentShotSlots,
} from '/modules/shots.js';

assertModuleSingleton('shotPlanDialog', import.meta.url);

const STRUCTURE_LOCK_BATCH_TYPES = new Set([
  'shots',
  'storyboard_prompts',
  'storyboard_images',
  'tail_frame_images',
  'video_prompts',
  'video_segments',
  'videos',
]);

const HIGH_FIELDS = [
  { field: 'duration', label: '时长', type: 'duration' },
  { field: 'shotType', label: '景别', options: SHOT_TYPES },
  { field: 'camera', label: '运镜', options: CAMERA_MOVES },
  { field: 'light', label: '光线', options: LIGHT_PRESETS },
];

const MORE_FIELDS = [
  { field: 'pace', label: '节奏', type: 'pace' },
  { field: 'angle', label: '角度', options: ANGLES },
  { field: 'lens', label: '焦距', options: LENSES },
  { field: 'focus', label: '景深', options: FOCUS_OPTIONS },
  { field: 'composition', label: '构图', options: COMPOSITION_PRESETS },
];

let _ctx = {};
let _overlay = null;
let _expanded = new Set();
let _selectedShotIdx = 0;
let _autosaveTimers = new Map();
let _autosaveDeltasByShot = new Map();
let _saveStateByShot = new Map();
let _bound = false;
let _lockState = { locked: false, reason: '' };
let _lockSeq = 0;
let _returnFocusEl = null;
const AUTOSAVE_DELAY_MS = 700;

const DETAIL_TEXT_FIELDS = [
  { field: 'visual', label: '画面描述' },
  { field: 'dialogue', label: '对白/旁白' },
  { field: 'audio', label: '音效' },
];

export function initShotPlanDialog(ctx) {
  _ctx = ctx || {};
  if (_bound) return;
  _bound = true;
  document.addEventListener('click', onGlobalClick);
  document.addEventListener('keydown', function (event) {
    if (!_overlay || _overlay.hidden) return;
    if (event.key === 'Escape') {
      closeShotPlanDialog();
    } else if (event.key === 'Tab') {
      trapDialogFocus(event);
    }
  });
}

export function openShotPlanDialog(triggerEl) {
  ensureOverlay();
  const project = currentProject();
  const shots = Array.isArray(project && project.shots) ? project.shots : [];
  _selectedShotIdx = Math.min(Math.max(0, _selectedShotIdx || 0), Math.max(0, shots.length - 1));
  clearAutosaveTimers();
  _autosaveDeltasByShot = new Map();
  _saveStateByShot = new Map();
  _returnFocusEl = triggerEl && typeof triggerEl.focus === 'function' ? triggerEl : document.activeElement;
  _overlay.hidden = false;
  document.body.classList.add('spd-open');
  render();
  focusInitialControl();
  refreshStructureLock();
}

export function closeShotPlanDialog() {
  if (!_overlay) return;
  flushPendingAutosaves();
  _overlay.hidden = true;
  document.body.classList.remove('spd-open');
  const target = _returnFocusEl && document.contains(_returnFocusEl) ? _returnFocusEl : null;
  _returnFocusEl = null;
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function currentProject() {
  return typeof _ctx.getProject === 'function' ? _ctx.getProject() : null;
}

function saveProject() {
  if (typeof _ctx.saveProject === 'function') return _ctx.saveProject();
}

function flushServerSave(opts) {
  if (typeof _ctx.flushServerSave === 'function') return _ctx.flushServerSave(opts);
  return Promise.resolve();
}

function renderShotList() {
  if (typeof _ctx.renderShotList === 'function') _ctx.renderShotList();
}

function refreshBoardPage() {
  if (typeof _ctx.refreshBoardPage === 'function') _ctx.refreshBoardPage();
}

function markShotStale(idx) {
  if (typeof _ctx.markDownstreamStale === 'function') {
    _ctx.markDownstreamStale('shot', { idx });
  }
}

function onGlobalClick(event) {
  const btn = event.target && event.target.closest ? event.target.closest('[data-action="open-shot-plan-dialog"]') : null;
  if (!btn) return;
  event.preventDefault();
  openShotPlanDialog(btn);
}

function ensureOverlay() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'spd-overlay';
  _overlay.hidden = true;
  _overlay.innerHTML = '<div class="spd-modal" role="dialog" aria-modal="true" aria-labelledby="spdTitle" tabindex="-1"><div class="spd-body" data-spd-body></div></div>';
  document.body.appendChild(_overlay);
  _overlay.addEventListener('click', onOverlayClick);
  _overlay.addEventListener('change', onOverlayChange);
  _overlay.addEventListener('input', onOverlayInput);
  _overlay.addEventListener('focusout', onOverlayFocusOut);
}

function focusInitialControl() {
  if (!_overlay || _overlay.hidden) return;
  const selected = _overlay.querySelector('[data-spd-action="select-shot"].is-active');
  const closeBtn = _overlay.querySelector('[data-spd-close]');
  const modal = _overlay.querySelector('.spd-modal');
  const target = selected || closeBtn || modal;
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
}

function getDialogFocusableElements() {
  if (!_overlay || _overlay.hidden) return [];
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(_overlay.querySelectorAll(selector)).filter(function (el) {
    if (!el || el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  });
}

function trapDialogFocus(event) {
  const focusables = getDialogFocusableElements();
  if (!focusables.length) {
    event.preventDefault();
    focusInitialControl();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!active || !_overlay.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

async function refreshStructureLock() {
  const project = currentProject();
  const seq = ++_lockSeq;
  const local = structureLockFromProject(project);
  if (local.locked || !project || !project.id) {
    _lockState = local;
    render();
    return;
  }
  try {
    const resp = await getActiveBatchesShared(project.id);
    if (seq !== _lockSeq) return;
    const batches = []
      .concat(Array.isArray(resp && resp.batches) ? resp.batches : [])
      .concat(Array.isArray(resp && resp.items) ? resp.items : []);
    const active = batches.find(function (batch) {
      const status = String((batch && (batch.status || batch.state)) || '').toLowerCase();
      const batchType = String((batch && (batch.batchType || batch.batch_type)) || '');
      return STRUCTURE_LOCK_BATCH_TYPES.has(batchType) && (status === 'queued' || status === 'running');
    });
    _lockState = active
      ? { locked: true, reason: '生成批次运行中，暂不能改镜头结构', batchType: active.batchType || active.batch_type }
      : { locked: false, reason: '' };
  } catch (_) {
    _lockState = local;
  }
  render();
  if (_overlay && !_overlay.hidden && !_overlay.contains(document.activeElement)) focusInitialControl();
}

function structureLockFromProject(project) {
  if (project && project.shotPlanStatus === 'generating') {
    return { locked: true, reason: '镜头计划生成中，暂不能改镜头结构', batchType: 'shots' };
  }
  return { locked: false, reason: '' };
}

function onOverlayClick(event) {
  const closeBtn = event.target && event.target.closest ? event.target.closest('[data-spd-close]') : null;
  if (closeBtn) {
    closeShotPlanDialog();
    return;
  }
  const btn = event.target && event.target.closest ? event.target.closest('[data-spd-action]') : null;
  if (!btn || btn.disabled) return;
  const action = btn.getAttribute('data-spd-action');
  const idx = Number(btn.closest('[data-shot-idx]') && btn.closest('[data-shot-idx]').getAttribute('data-shot-idx'));
  if (action === 'toggle-more') {
    if (_expanded.has(idx)) _expanded.delete(idx);
    else _expanded.add(idx);
    refreshShotPlanPanels();
  } else if (action === 'select-shot') {
    selectShot(idx);
  } else if (action === 'merge-next') {
    regroup('merge-next', idx);
  } else if (action === 'split-out') {
    regroup('split-out', idx);
  } else if (action === 'move-prev') {
    regroup('move-prev', idx);
  } else if (action === 'move-next') {
    regroup('move-next', idx);
  } else if (action === 'swap-up') {
    swapAdjacent(idx, -1);
  } else if (action === 'swap-down') {
    swapAdjacent(idx, 1);
  }
}

function onOverlayChange(event) {
  const select = event.target && event.target.closest ? event.target.closest('[data-spd-field]') : null;
  if (!select || select.tagName !== 'SELECT') return;
  applyFieldAutosave(select, { immediate: true });
}

function onOverlayInput(event) {
  const field = event.target && event.target.closest ? event.target.closest('[data-spd-field]') : null;
  if (!field || field.tagName !== 'TEXTAREA') return;
  applyFieldAutosave(field, { immediate: false });
}

function onOverlayFocusOut(event) {
  const field = event.target && event.target.closest ? event.target.closest('[data-spd-field]') : null;
  if (!field) return;
  const row = field.closest('[data-shot-idx]');
  const idx = Number(row && row.getAttribute('data-shot-idx'));
  if (Number.isInteger(idx)) flushAutosaveForShot(idx);
}

function applyFieldAutosave(fieldEl, opts) {
  opts = opts || {};
  const row = fieldEl.closest('[data-shot-idx]');
  const idx = Number(row && row.getAttribute('data-shot-idx'));
  const field = fieldEl.getAttribute('data-spd-field');
  if (!Number.isInteger(idx) || !field) return;
  const project = currentProject();
  const shot = project && Array.isArray(project.shots) ? project.shots[idx] : null;
  if (!shot) return;
  const before = _shotFieldCurrent(shot, field);
  const value = fieldEl.value;
  if (String(before) === String(value)) {
    syncSaveIndicators(idx);
    return;
  }
  _applyShotFieldValue(shot, field, value);
  recordAutosaveDelta(idx, field, value);
  markShotStale(idx);
  renderShotList();
  refreshBoardPage();
  scheduleAutosave(idx, { immediate: !!opts.immediate });
}

function editableFieldNames() {
  return HIGH_FIELDS.concat(MORE_FIELDS).map(function (spec) { return spec.field; })
    .concat(DETAIL_TEXT_FIELDS.map(function (spec) { return spec.field; }));
}

function fieldValue(shot, field) {
  if (editableFieldNames().indexOf(field) < 0) return '';
  return _shotFieldCurrent(shot, field);
}

function clearAutosaveTimers() {
  _autosaveTimers.forEach(function (timer) { clearTimeout(timer); });
  _autosaveTimers = new Map();
}

function recordAutosaveDelta(idx, field, value) {
  if (!Number.isInteger(idx) || editableFieldNames().indexOf(field) < 0) return;
  const delta = _autosaveDeltasByShot.get(idx) || {};
  delta[field] = value;
  _autosaveDeltasByShot.set(idx, delta);
}

function autosaveDeltaSnapshot(indexes) {
  return indexes.map(function (idx) {
    const delta = _autosaveDeltasByShot.get(idx) || {};
    const fields = {};
    Object.keys(delta).forEach(function (field) {
      if (editableFieldNames().indexOf(field) >= 0) fields[field] = delta[field];
    });
    return { idx: idx, fields: fields };
  }).filter(function (entry) {
    return Object.keys(entry.fields).length > 0;
  });
}

function clearAutosaveDeltaSnapshot(snapshot) {
  snapshot.forEach(function (entry) {
    const current = _autosaveDeltasByShot.get(entry.idx);
    if (!current) return;
    Object.keys(entry.fields).forEach(function (field) {
      if (String(current[field]) === String(entry.fields[field])) delete current[field];
    });
    if (!Object.keys(current).length) _autosaveDeltasByShot.delete(entry.idx);
  });
}

function replayAutosaveDeltaSnapshot(snapshot) {
  const project = currentProject();
  const shots = Array.isArray(project && project.shots) ? project.shots : [];
  snapshot.forEach(function (entry) {
    const shot = shots[entry.idx];
    if (!shot) return;
    Object.keys(entry.fields).forEach(function (field) {
      _applyShotFieldValue(shot, field, entry.fields[field]);
      recordAutosaveDelta(entry.idx, field, entry.fields[field]);
    });
    markShotStale(entry.idx);
  });
  renderShotList();
  refreshBoardPage();
  refreshShotPlanPanels();
}

function selectShot(idx) {
  const project = currentProject();
  const shots = Array.isArray(project && project.shots) ? project.shots : [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= shots.length) return;
  _selectedShotIdx = idx;
  refreshShotPlanPanels();
}

function getSaveState(idx) {
  return _saveStateByShot.get(idx) || { state: 'saved', label: '已保存' };
}

function setSaveState(idx, state, label) {
  if (!Number.isInteger(idx)) return;
  _saveStateByShot.set(idx, { state: state || 'saved', label: label || '已保存' });
  syncSaveIndicators(idx);
}

function syncSaveIndicators(idx) {
  if (!_overlay) return;
  const listBtn = _overlay.querySelector('.spd-shot-list-row[data-shot-idx="' + idx + '"]');
  const saveState = getSaveState(idx);
  if (listBtn) {
    listBtn.classList.toggle('is-saving', saveState.state === 'saving');
    listBtn.classList.toggle('is-save-error', saveState.state === 'error');
  }
  const stateEl = _overlay.querySelector('[data-spd-save-state][data-shot-idx="' + idx + '"]');
  if (stateEl) {
    stateEl.textContent = saveState.label || '已保存';
    stateEl.classList.toggle('is-saving', saveState.state === 'saving');
    stateEl.classList.toggle('is-save-error', saveState.state === 'error');
  }
}

function persistAutosave(indexes) {
  indexes = indexes.filter(function (idx, pos) {
    return Number.isInteger(idx) && indexes.indexOf(idx) === pos;
  });
  if (!indexes.length) return Promise.resolve({ ok: true });
  const deltaSnapshot = autosaveDeltaSnapshot(indexes);
  indexes.forEach(function (idx) { setSaveState(idx, 'saving', '保存中'); });
  try {
    saveProject();
  } catch (e) {
    indexes.forEach(function (idx) { setSaveState(idx, 'error', '保存失败，已保留在当前页面'); });
    showToast('镜头计划保存失败，请稍后重试', 'error');
    return Promise.resolve({ ok: false, error: e });
  }
  return Promise.resolve(flushServerSave({
    silent: true,
    staleRetryLimit: 1,
    onStaleReload: function () {
      replayAutosaveDeltaSnapshot(deltaSnapshot);
    },
  })).then(function (result) {
    if (result && result.ok === false && result.stale) {
      indexes.forEach(function (idx) { setSaveState(idx, 'error', '保存冲突，已保留在当前页面，请稍后重试'); });
      return result;
    }
    if (result && result.ok === false) {
      indexes.forEach(function (idx) { setSaveState(idx, 'error', '保存失败，已保留在当前页面'); });
      showToast('镜头计划保存失败，请稍后重试', 'error');
      return result;
    }
    clearAutosaveDeltaSnapshot(deltaSnapshot);
    indexes.forEach(function (idx) { setSaveState(idx, 'saved', '已保存'); });
    return result || { ok: true };
  }).catch(function (e) {
    indexes.forEach(function (idx) { setSaveState(idx, 'error', '保存失败，已保留在当前页面'); });
    showToast('镜头计划保存失败，请稍后重试', 'error');
    return { ok: false, error: e };
  });
}

function scheduleAutosave(idx, opts) {
  opts = opts || {};
  if (!Number.isInteger(idx)) return Promise.resolve({ ok: false });
  const existing = _autosaveTimers.get(idx);
  if (existing) clearTimeout(existing);
  _autosaveTimers.delete(idx);
  setSaveState(idx, 'saving', '保存中');
  if (opts.immediate) return persistAutosave([idx]);
  const timer = setTimeout(function () {
    _autosaveTimers.delete(idx);
    persistAutosave([idx]);
  }, AUTOSAVE_DELAY_MS);
  _autosaveTimers.set(idx, timer);
  return Promise.resolve({ ok: true, queued: true });
}

function flushAutosaveForShot(idx) {
  const timer = _autosaveTimers.get(idx);
  if (!timer) return Promise.resolve({ ok: true });
  clearTimeout(timer);
  _autosaveTimers.delete(idx);
  return persistAutosave([idx]);
}

function flushPendingAutosaves() {
  const indexes = Array.from(_autosaveTimers.keys());
  if (!indexes.length) return Promise.resolve({ ok: true });
  indexes.forEach(function (idx) {
    const timer = _autosaveTimers.get(idx);
    if (timer) clearTimeout(timer);
  });
  _autosaveTimers.clear();
  return persistAutosave(indexes);
}

function refreshShotPlanPanels() {
  if (!_overlay || _overlay.hidden) return;
  const project = currentProject();
  const shots = Array.isArray(project && project.shots) ? project.shots : [];
  const groups = readGroups(project || {});
  if (!shots.length) {
    render();
    return;
  }
  _selectedShotIdx = Math.min(Math.max(0, _selectedShotIdx || 0), shots.length - 1);
  const list = _overlay.querySelector('[data-spd-list]');
  const detail = _overlay.querySelector('[data-spd-detail]');
  if (list) list.innerHTML = renderShotListItems(project, shots, groups);
  if (detail) detail.innerHTML = renderShotDetail(project, shots[_selectedShotIdx], _selectedShotIdx, groups);
}

function readGroups(project) {
  const shots = Array.isArray(project && project.shots) ? project.shots : [];
  const count = shots.length;
  const storyboards = Array.isArray(project && project.storyboards) ? project.storyboards : [];
  const groups = storyboards.map(function (sb) {
    return Array.isArray(sb && sb.shotIndices) ? sb.shotIndices.map(Number).filter(Number.isFinite) : [];
  }).filter(function (arr) { return arr.length; });
  if (groupsCover(groups, count)) return groups;
  return shots.map(function (_, idx) { return [idx]; });
}

function groupsCover(groups, shotCount) {
  const seen = new Set();
  let expectedNext = 0;
  for (const group of groups) {
    if (!Array.isArray(group) || !group.length) return false;
    for (let i = 0; i < group.length; i++) {
      const idx = group[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= shotCount) return false;
      if (idx !== expectedNext) return false;
      if (i > 0 && group[i - 1] + 1 !== idx) return false;
      if (seen.has(idx)) return false;
      seen.add(idx);
      expectedNext += 1;
    }
  }
  return seen.size === shotCount && expectedNext === shotCount;
}

function findGroup(groups, shotIdx) {
  for (let g = 0; g < groups.length; g++) {
    if (groups[g].indexOf(shotIdx) >= 0) return g;
  }
  return -1;
}

function regroup(action, shotIdx) {
  if (_lockState.locked) {
    showToast(_lockState.reason || '生成中暂不能修改镜头结构', 'warn');
    return;
  }
  const project = currentProject();
  if (!project || !Array.isArray(project.shots)) return;
  const groups = readGroups(project).map(function (group) { return group.slice(); });
  const gIdx = findGroup(groups, shotIdx);
  if (gIdx < 0) return;
  if (action === 'merge-next') mergeNext(groups, shotIdx, gIdx);
  else if (action === 'split-out') splitOut(groups, shotIdx, gIdx);
  else if (action === 'move-prev') moveBoundary(groups, shotIdx, gIdx, -1);
  else if (action === 'move-next') moveBoundary(groups, shotIdx, gIdx, 1);
  else return;
  if (!groupsCover(groups, project.shots.length)) {
    showToast('片段分组必须连续覆盖全部镜头，本次调整已撤销', 'error');
    return;
  }
  applyGroupsToProject(project, groups);
  saveProject();
  renderShotList();
  refreshBoardPage();
  render();
}

function swapAdjacent(shotIdx, direction) {
  if (_lockState.locked) {
    showToast(_lockState.reason || '生成中暂不能修改镜头结构', 'warn');
    return;
  }
  const result = _swapAdjacentShotSlots(shotIdx, direction);
  if (!result || !result.ok) {
    const reason = result && result.reason;
    if (reason === 'segment_boundary') {
      showToast('跨多镜片段边界请先用片段分组操作调整归属', 'warn');
    } else {
      showToast('当前镜头不能继续移动', 'warn');
    }
    return;
  }
  const toIdx = shotIdx + (direction < 0 ? -1 : 1);
  markShotStale(Math.min(shotIdx, toIdx));
  markShotStale(Math.max(shotIdx, toIdx));
  saveProject();
  renderShotList();
  refreshBoardPage();
  render();
}

function mergeNext(groups, shotIdx, gIdx) {
  const group = groups[gIdx];
  const pos = group.indexOf(shotIdx);
  if (pos >= 0 && pos < group.length - 1) return;
  if (gIdx + 1 >= groups.length) return;
  groups[gIdx] = group.concat(groups[gIdx + 1]);
  groups.splice(gIdx + 1, 1);
}

function splitOut(groups, shotIdx, gIdx) {
  const group = groups[gIdx];
  if (group.length <= 1) return;
  const pos = group.indexOf(shotIdx);
  const next = [];
  if (pos > 0) next.push(group.slice(0, pos));
  next.push([shotIdx]);
  if (pos < group.length - 1) next.push(group.slice(pos + 1));
  groups.splice(gIdx, 1, ...next);
}

function moveBoundary(groups, shotIdx, gIdx, dir) {
  const group = groups[gIdx];
  if (!group || group.length <= 1) return;
  if (dir < 0) {
    if (group[0] !== shotIdx || gIdx <= 0) return;
    groups[gIdx - 1] = groups[gIdx - 1].concat([shotIdx]);
    groups[gIdx] = group.slice(1);
  } else {
    if (group[group.length - 1] !== shotIdx || gIdx + 1 >= groups.length) return;
    groups[gIdx + 1] = [shotIdx].concat(groups[gIdx + 1]);
    groups[gIdx] = group.slice(0, -1);
  }
}

function applyGroupsToProject(project, groups) {
  const oldStoryboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const oldVideoTasks = Array.isArray(project.videoTasks) ? project.videoTasks : [];
  const byKey = new Map();
  oldStoryboards.forEach(function (sb, idx) {
    const key = Array.isArray(sb && sb.shotIndices) ? sb.shotIndices.join(',') : String(idx);
    if (!byKey.has(key)) byKey.set(key, { storyboard: sb, videoTask: oldVideoTasks[idx] });
  });
  const nextStoryboards = [];
  const nextVideoTasks = [];
  groups.forEach(function (group, groupIdx) {
    const key = group.join(',');
    const source = byKey.get(key) || byKey.get(String(group[0])) || {};
    nextStoryboards[groupIdx] = Object.assign({}, source.storyboard || {}, {
      groupIdx,
      shotIdx: group[0] + 1,
      shotIndices: group.slice(),
    });
    if (source.videoTask) {
      nextVideoTasks[groupIdx] = Object.assign({}, source.videoTask, {
        groupIdx,
        shotIdx: group[0] + 1,
        shotIndices: group.slice(),
      });
    }
  });
  project.storyboards = nextStoryboards;
  project.videoTasks = nextVideoTasks;
  project.frameWorkflowSchemaVersion = 3;
  project.segmentationMode = 'manual';
  if (!project._staleFlags || typeof project._staleFlags !== 'object') project._staleFlags = {};
  groups.forEach(function (_, groupIdx) {
    project._staleFlags['storyboard_' + groupIdx] = true;
    project._staleFlags['video_prompt_' + groupIdx] = true;
    project._staleFlags['video_segment_' + groupIdx] = true;
  });
}

function fieldSelect(spec, shot, idx) {
  const current = fieldValue(shot, spec.field);
  let options = '';
  if (spec.type === 'duration') options = _buildDurationOptions(current);
  else if (spec.type === 'pace') options = _buildPaceOptions(current);
  else options = _buildSelectOptions(spec.options || [], current);
  return '<label class="spd-chip"><span>' + escapeHtml(spec.label) + '</span><select data-spd-field="' + escapeHtml(spec.field) + '">' + options + '</select></label>';
}

function textareaField(label, field, shot, idx) {
  return '<label class="spd-textfield"><span>' + escapeHtml(label) + '</span><textarea rows="3" data-spd-field="' + escapeHtml(field) + '">' + escapeHtml(fieldValue(shot, field)) + '</textarea></label>';
}

function structureActionButton(action, label, enabled, disabledReason, locked) {
  const reason = locked ? (_lockState.reason || '生成中暂不能修改结构') : (disabledReason || '');
  const disabled = locked || !enabled;
  return '<button type="button" data-spd-action="' + escapeHtml(action) + '"' +
    (disabled ? ' disabled aria-disabled="true"' : '') +
    (reason ? ' data-disabled-reason="' + escapeHtml(reason) + '"' : '') +
    '><span>' + escapeHtml(label) + '</span>' +
    (disabled && reason ? '<small>' + escapeHtml(reason) + '</small>' : '') +
  '</button>';
}

function groupActions(groups, shotIdx, locked) {
  const gIdx = findGroup(groups, shotIdx);
  const group = groups[gIdx] || [shotIdx];
  const totalShots = groups.reduce(function (acc, item) { return acc + item.length; }, 0);
  const canMovePrev = group.length > 1 && group[0] === shotIdx && gIdx > 0;
  const canMoveNext = group.length > 1 && group[group.length - 1] === shotIdx && gIdx + 1 < groups.length;
  const canSplit = group.length > 1;
  const canMerge = group[group.length - 1] === shotIdx && gIdx + 1 < groups.length;
  const mergeReason = group[group.length - 1] !== shotIdx ? '只能从片段最后一镜合并' : '没有下一段可合并';
  const movePrevReason = group.length <= 1 ? '单镜头片段不能并段' : (group[0] !== shotIdx ? '只有片段第一镜可并入上一段' : '没有上一段');
  const moveNextReason = group.length <= 1 ? '单镜头片段不能并段' : (group[group.length - 1] !== shotIdx ? '只有片段最后一镜可并入下一段' : '没有下一段');
  return '<div class="spd-row-actions" data-spd-structure-actions>' +
    structureActionButton('swap-up', '上移', shotIdx > 0, '已经是第一个镜头', locked) +
    structureActionButton('swap-down', '下移', shotIdx + 1 < totalShots, '已经是最后一个镜头', locked) +
    structureActionButton('merge-next', '与下一镜合并', canMerge, mergeReason, locked) +
    structureActionButton('split-out', '拆出片段', canSplit, '单镜头片段不能拆分', locked) +
    structureActionButton('move-prev', '并入上一段', canMovePrev, movePrevReason, locked) +
    structureActionButton('move-next', '并入下一段', canMoveNext, moveNextReason, locked) +
  '</div>';
}

function renderShotListItem(project, shot, idx, groups) {
  const groupIdx = findGroup(groups, idx);
  const group = groups[groupIdx] || [idx];
  const active = idx === _selectedShotIdx;
  const saveState = getSaveState(idx);
  const visual = String(_shotFieldCurrent(shot, 'visual') || '').trim();
  const locked = !!_lockState.locked;
  return '<div class="spd-shot-list-row' + (active ? ' is-active' : '') + (saveState.state === 'saving' ? ' is-saving' : '') + (saveState.state === 'error' ? ' is-save-error' : '') + '" data-shot-idx="' + idx + '">' +
    '<button type="button" class="spd-shot-list-item" data-spd-action="select-shot" aria-selected="' + (active ? 'true' : 'false') + '">' +
      '<strong>' + String(idx + 1).padStart(2, '0') + '</strong>' +
      '<span>镜头 ' + escapeHtml(idx + 1) + '</span>' +
      '<small>片段 ' + escapeHtml(groupIdx + 1) + ' · ' + escapeHtml(group.map(function (n) { return n + 1; }).join(' / ')) + '</small>' +
      '<em>' + escapeHtml(visual || '暂无画面描述') + '</em>' +
    '</button>' +
    '<details class="spd-structure-menu">' +
      '<summary aria-label="镜头' + escapeHtml(idx + 1) + '结构操作"><span>结构</span><strong>···</strong></summary>' +
      groupActions(groups, idx, locked) +
    '</details>' +
  '</div>';
}

function renderShotListItems(project, shots, groups) {
  return shots.map(function (shot, idx) { return renderShotListItem(project, shot, idx, groups); }).join('');
}

function renderShotDetail(project, shot, idx, groups) {
  const groupIdx = findGroup(groups, idx);
  const group = groups[groupIdx] || [idx];
  const expanded = _expanded.has(idx);
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const storyboard = groupIdx >= 0 ? storyboards[groupIdx] : null;
  const videoPrompt = String((storyboard && storyboard.videoPrompt) || '').trim();
  const locked = !!_lockState.locked;
  const saveState = getSaveState(idx);
  return '<article class="spd-row spd-row--detail" data-shot-idx="' + idx + '">' +
    '<div class="spd-row-main">' +
      '<div class="spd-shot-no"><strong>' + String(idx + 1).padStart(2, '0') + '</strong><span>镜头</span></div>' +
      '<div class="spd-group-cell"><span class="spd-group-pill">片段 ' + escapeHtml(groupIdx + 1) + '</span><small>' + escapeHtml(group.map(function (n) { return n + 1; }).join(' / ')) + '</small></div>' +
      '<div class="spd-field-stack">' +
        '<div class="spd-chip-row">' + HIGH_FIELDS.map(function (spec) { return fieldSelect(spec, shot, idx); }).join('') + '</div>' +
        (expanded ? '<div class="spd-chip-row spd-chip-row--more">' + MORE_FIELDS.map(function (spec) { return fieldSelect(spec, shot, idx); }).join('') + '</div>' : '') +
      '</div>' +
      '<button type="button" class="spd-more-btn" data-spd-action="toggle-more">' + (expanded ? '收起参数' : '更多参数') + '</button>' +
    '</div>' +
    '<div class="spd-row-detail">' +
      DETAIL_TEXT_FIELDS.map(function (spec) { return textareaField(spec.label, spec.field, shot, idx); }).join('') +
      '<label class="spd-textfield spd-textfield--readonly"><span>最终提示词</span><textarea rows="2" readonly>' + escapeHtml(videoPrompt || '未生成') + '</textarea></label>' +
      '<div class="spd-detail-footer"><span class="spd-save-state' + (saveState.state === 'saving' ? ' is-saving' : '') + (saveState.state === 'error' ? ' is-save-error' : '') + '" data-spd-save-state data-shot-idx="' + idx + '">' + escapeHtml(saveState.label || '已保存') + '</span></div>' +
    '</div>' +
  '</article>';
}

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function shotUidOf(shot) {
  return cleanText(shot && (shot.shotUid || shot.shot_uid));
}

function hasFirstFrameCandidate(storyboard, shotUid) {
  const frames = storyboard && storyboard.shotFrames && typeof storyboard.shotFrames === 'object' ? storyboard.shotFrames : {};
  const state = shotUid ? frames[shotUid] : null;
  if (state && Array.isArray(state.candidates) && state.candidates.some(function (candidate) {
    return !!cleanText(candidate && candidate.url);
  })) return true;
  return !!cleanText(storyboard && (storyboard.firstFrameUrl || storyboard.imageUrl || storyboard.coverUrl || storyboard.selectedImageUrl));
}

function hasReadyVideo(project, groupIdx) {
  const storyboards = Array.isArray(project && project.storyboards) ? project.storyboards : [];
  const videoTasks = Array.isArray(project && project.videoTasks) ? project.videoTasks : [];
  const sb = storyboards[groupIdx] || {};
  const vt = videoTasks[groupIdx] || {};
  const status = cleanText(sb.videoStatus || vt.status).toLowerCase();
  if (status === 'failed' || status === 'timeout' || status === 'error') return false;
  if (status === 'generating' || status === 'running' || status === 'queued') return false;
  return !!cleanText(sb.videoTaskId || vt.taskId || sb.videoUrl || vt.url || vt.protectedUrl);
}

function renderProgressStatus(project, shots, groups) {
  const storyboards = Array.isArray(project && project.storyboards) ? project.storyboards : [];
  let firstFrameReady = 0;
  let missingUid = 0;
  shots.forEach(function (shot, idx) {
    const uid = shotUidOf(shot);
    if (!uid) missingUid += 1;
    const gIdx = findGroup(groups, idx);
    const sb = gIdx >= 0 ? storyboards[gIdx] : null;
    if (hasFirstFrameCandidate(sb, uid)) firstFrameReady += 1;
  });
  const videoReady = groups.filter(function (_, groupIdx) {
    return hasReadyVideo(project, groupIdx);
  }).length;
  const bits = [
    '镜头 ' + shots.length + ' 个',
    '片段 ' + groups.length + ' 个',
    '首帧 ' + firstFrameReady + '/' + shots.length,
    '视频 ' + videoReady + '/' + groups.length,
  ];
  if (missingUid > 0) bits.push('待修复 ' + missingUid + ' 个镜头标识');
  let next = '→ 下一步：准备首帧';
  if (missingUid > 0) next = '→ 下一步：补齐镜头标识';
  else if (shots.length && firstFrameReady >= shots.length) next = '→ 下一步：生成视频';
  if (groups.length && videoReady >= groups.length) next = '→ 已完成，可进入剪辑';
  return '<div class="spd-progress"><span>' + escapeHtml(bits.join(' · ')) + '</span><strong>' + escapeHtml(next) + '</strong></div>';
}

function render() {
  if (!_overlay || _overlay.hidden) return;
  const project = currentProject();
  const body = _overlay.querySelector('[data-spd-body]');
  if (!body) return;
  const shots = Array.isArray(project && project.shots) ? project.shots : [];
  const groups = readGroups(project || {});
  if (shots.length) {
    _selectedShotIdx = Math.min(Math.max(0, _selectedShotIdx || 0), shots.length - 1);
  }
  const lockHtml = _lockState.locked
    ? '<div class="spd-lock"><span class="material-symbols-outlined">lock</span>' + escapeHtml(_lockState.reason || '生成中暂不能修改镜头结构') + '</div>'
    : '';
  body.innerHTML =
    '<header class="spd-head">' +
      '<div><p>镜头计划</p><h2 id="spdTitle">' + escapeHtml(shots.length || 0) + ' 个镜头 · ' + escapeHtml(groups.length || 0) + ' 个片段</h2></div>' +
      '<button type="button" class="spd-close" data-spd-close aria-label="关闭"><span class="material-symbols-outlined">close</span></button>' +
    '</header>' +
    renderProgressStatus(project || {}, shots, groups) +
    lockHtml +
    (shots.length
      ? '<section class="spd-workbench"><aside class="spd-shot-list" data-spd-list>' + renderShotListItems(project, shots, groups) + '</aside><section class="spd-detail-panel" data-spd-detail>' + renderShotDetail(project, shots[_selectedShotIdx], _selectedShotIdx, groups) + '</section></section>'
      : '<section class="spd-list"><div class="spd-empty">暂无镜头计划</div></section>');
}
