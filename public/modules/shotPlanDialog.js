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
let _draftsByShot = new Map();
let _bound = false;
let _lockState = { locked: false, reason: '' };
let _lockSeq = 0;
let _returnFocusEl = null;

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
  _draftsByShot = new Map();
  _returnFocusEl = triggerEl && typeof triggerEl.focus === 'function' ? triggerEl : document.activeElement;
  _overlay.hidden = false;
  document.body.classList.add('spd-open');
  render();
  focusInitialControl();
  refreshStructureLock();
}

export function closeShotPlanDialog() {
  if (!_overlay) return;
  _overlay.hidden = true;
  document.body.classList.remove('spd-open');
  _draftsByShot = new Map();
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
  } else if (action === 'apply-current') {
    applyDraftToShot(idx);
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
  updateDraftField(select);
}

function onOverlayInput(event) {
  const field = event.target && event.target.closest ? event.target.closest('[data-spd-field]') : null;
  if (!field || field.tagName !== 'TEXTAREA') return;
  updateDraftField(field);
}

function updateDraftField(fieldEl) {
  const row = fieldEl.closest('[data-shot-idx]');
  const idx = Number(row && row.getAttribute('data-shot-idx'));
  const field = fieldEl.getAttribute('data-spd-field');
  if (!Number.isInteger(idx) || !field) return;
  const draft = ensureDraft(idx);
  if (!draft) return;
  draft.fields[field] = fieldEl.value;
  syncDraftIndicators(idx);
}

function applyDraftToShot(idx) {
  const project = currentProject();
  const shot = project && Array.isArray(project.shots) ? project.shots[idx] : null;
  const draft = _draftsByShot.get(idx);
  if (!shot || !draft) return;
  let changed = false;
  Object.keys(draft.fields).forEach(function (field) {
    const before = _shotFieldCurrent(shot, field);
    const value = draft.fields[field];
    if (String(before) === String(value)) return;
    _applyShotFieldValue(shot, field, value);
    changed = true;
  });
  if (!changed) {
    syncDraftIndicators(idx);
    return;
  }
  markShotStale(idx);
  saveProject();
  renderShotList();
  refreshBoardPage();
  _draftsByShot.set(idx, makeDraftFromShot(shot));
  refreshShotPlanPanels();
}

function editableFieldNames() {
  return HIGH_FIELDS.concat(MORE_FIELDS).map(function (spec) { return spec.field; })
    .concat(DETAIL_TEXT_FIELDS.map(function (spec) { return spec.field; }));
}

function makeDraftFromShot(shot) {
  const fields = {};
  editableFieldNames().forEach(function (field) {
    fields[field] = _shotFieldCurrent(shot, field);
  });
  return { fields };
}

function ensureDraft(idx) {
  if (_draftsByShot.has(idx)) return _draftsByShot.get(idx);
  const project = currentProject();
  const shot = project && Array.isArray(project.shots) ? project.shots[idx] : null;
  if (!shot) return null;
  const draft = makeDraftFromShot(shot);
  _draftsByShot.set(idx, draft);
  return draft;
}

function draftValue(shot, idx, field) {
  const draft = ensureDraft(idx);
  if (draft && Object.prototype.hasOwnProperty.call(draft.fields, field)) return draft.fields[field];
  return _shotFieldCurrent(shot, field);
}

function isDraftDirty(idx) {
  const project = currentProject();
  const shot = project && Array.isArray(project.shots) ? project.shots[idx] : null;
  const draft = _draftsByShot.get(idx);
  if (!shot || !draft) return false;
  return Object.keys(draft.fields).some(function (field) {
    return String(_shotFieldCurrent(shot, field)) !== String(draft.fields[field]);
  });
}

function selectShot(idx) {
  const project = currentProject();
  const shots = Array.isArray(project && project.shots) ? project.shots : [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= shots.length) return;
  _selectedShotIdx = idx;
  ensureDraft(idx);
  refreshShotPlanPanels();
}

function syncDraftIndicators(idx) {
  if (!_overlay) return;
  const dirty = isDraftDirty(idx);
  const applyBtn = _overlay.querySelector('[data-spd-action="apply-current"][data-shot-idx="' + idx + '"]');
  if (applyBtn) {
    applyBtn.disabled = !dirty;
    applyBtn.setAttribute('aria-disabled', dirty ? 'false' : 'true');
  }
  const listBtn = _overlay.querySelector('[data-spd-action="select-shot"][data-shot-idx="' + idx + '"]');
  if (listBtn) listBtn.classList.toggle('is-dirty', dirty);
  const dirtyState = _overlay.querySelector('[data-spd-dirty-state][data-shot-idx="' + idx + '"]');
  if (dirtyState) dirtyState.textContent = dirty ? '有未应用修改' : '当前镜头未修改';
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
  const current = draftValue(shot, idx, spec.field);
  let options = '';
  if (spec.type === 'duration') options = _buildDurationOptions(current);
  else if (spec.type === 'pace') options = _buildPaceOptions(current);
  else options = _buildSelectOptions(spec.options || [], current);
  return '<label class="spd-chip"><span>' + escapeHtml(spec.label) + '</span><select data-spd-field="' + escapeHtml(spec.field) + '">' + options + '</select></label>';
}

function textareaField(label, field, shot, idx) {
  return '<label class="spd-textfield"><span>' + escapeHtml(label) + '</span><textarea rows="3" data-spd-field="' + escapeHtml(field) + '">' + escapeHtml(draftValue(shot, idx, field)) + '</textarea></label>';
}

function groupActions(groups, shotIdx, locked) {
  const gIdx = findGroup(groups, shotIdx);
  const group = groups[gIdx] || [shotIdx];
  const canMovePrev = group.length > 1 && group[0] === shotIdx && gIdx > 0;
  const canMoveNext = group.length > 1 && group[group.length - 1] === shotIdx && gIdx + 1 < groups.length;
  const canSplit = group.length > 1;
  const canMerge = group[group.length - 1] === shotIdx && gIdx + 1 < groups.length;
  const dis = locked ? ' disabled aria-disabled="true"' : '';
  return '<div class="spd-row-actions">' +
    '<button type="button" data-spd-action="swap-up"' + (shotIdx > 0 ? dis : ' disabled aria-disabled="true"') + '>上移</button>' +
    '<button type="button" data-spd-action="swap-down"' + (shotIdx + 1 < groups.reduce(function (acc, item) { return acc + item.length; }, 0) ? dis : ' disabled aria-disabled="true"') + '>下移</button>' +
    '<button type="button" data-spd-action="merge-next"' + (canMerge ? dis : ' disabled aria-disabled="true"') + '>与下一镜合并</button>' +
    '<button type="button" data-spd-action="split-out"' + (canSplit ? dis : ' disabled aria-disabled="true"') + '>拆出片段</button>' +
    '<button type="button" data-spd-action="move-prev"' + (canMovePrev ? dis : ' disabled aria-disabled="true"') + '>并入上一段</button>' +
    '<button type="button" data-spd-action="move-next"' + (canMoveNext ? dis : ' disabled aria-disabled="true"') + '>并入下一段</button>' +
  '</div>';
}

function renderShotListItem(project, shot, idx, groups) {
  const groupIdx = findGroup(groups, idx);
  const group = groups[groupIdx] || [idx];
  const active = idx === _selectedShotIdx;
  const dirty = isDraftDirty(idx);
  const visual = String(_shotFieldCurrent(shot, 'visual') || '').trim();
  return '<button type="button" class="spd-shot-list-item' + (active ? ' is-active' : '') + (dirty ? ' is-dirty' : '') + '" data-spd-action="select-shot" data-shot-idx="' + idx + '" aria-selected="' + (active ? 'true' : 'false') + '">' +
    '<strong>' + String(idx + 1).padStart(2, '0') + '</strong>' +
    '<span>镜头 ' + escapeHtml(idx + 1) + '</span>' +
    '<small>片段 ' + escapeHtml(groupIdx + 1) + ' · ' + escapeHtml(group.map(function (n) { return n + 1; }).join(' / ')) + '</small>' +
    '<em>' + escapeHtml(visual || '暂无画面描述') + '</em>' +
  '</button>';
}

function renderShotListItems(project, shots, groups) {
  return shots.map(function (shot, idx) { return renderShotListItem(project, shot, idx, groups); }).join('');
}

function renderShotDetail(project, shot, idx, groups) {
  ensureDraft(idx);
  const groupIdx = findGroup(groups, idx);
  const group = groups[groupIdx] || [idx];
  const expanded = _expanded.has(idx);
  const storyboards = Array.isArray(project.storyboards) ? project.storyboards : [];
  const storyboard = groupIdx >= 0 ? storyboards[groupIdx] : null;
  const videoPrompt = String((storyboard && storyboard.videoPrompt) || '').trim();
  const locked = !!_lockState.locked;
  const dirty = isDraftDirty(idx);
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
      groupActions(groups, idx, locked) +
      '<div class="spd-detail-footer"><span data-spd-dirty-state data-shot-idx="' + idx + '">' + (dirty ? '有未应用修改' : '当前镜头未修改') + '</span><button type="button" class="spd-apply-btn" data-spd-action="apply-current" data-shot-idx="' + idx + '"' + (dirty ? '' : ' disabled aria-disabled="true"') + '>应用本镜头</button></div>' +
    '</div>' +
  '</article>';
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
    ensureDraft(_selectedShotIdx);
  }
  const lockHtml = _lockState.locked
    ? '<div class="spd-lock"><span class="material-symbols-outlined">lock</span>' + escapeHtml(_lockState.reason || '生成中暂不能修改镜头结构') + '</div>'
    : '';
  body.innerHTML =
    '<header class="spd-head">' +
      '<div><p>镜头计划</p><h2 id="spdTitle">' + escapeHtml(shots.length || 0) + ' 个镜头 · ' + escapeHtml(groups.length || 0) + ' 个片段</h2></div>' +
      '<button type="button" class="spd-close" data-spd-close aria-label="关闭"><span class="material-symbols-outlined">close</span></button>' +
    '</header>' +
    '<div class="spd-progress"><span>1/3 完成后可批量生视频</span><strong>→ 下一步：准备资产</strong></div>' +
    lockHtml +
    (shots.length
      ? '<section class="spd-workbench"><aside class="spd-shot-list" data-spd-list>' + renderShotListItems(project, shots, groups) + '</aside><section class="spd-detail-panel" data-spd-detail>' + renderShotDetail(project, shots[_selectedShotIdx], _selectedShotIdx, groups) + '</section></section>'
      : '<section class="spd-list"><div class="spd-empty">暂无镜头计划</div></section>');
}
