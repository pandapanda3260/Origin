import { describeProject, searchEditMaterial, updateProject, getEffectList, submitEditTaskAsync, deleteEditMaterial, createEditMaterial, updateMediaPublishStatus, searchVideo, getVideoPlayInfo, mGetMaterial, uploadMaterial, listVideoClassifications } from './actions.js';
import { getType } from './util.js';

const VEV_PROJECT_ID = import.meta.env.VITE_VEV_PROJECT_ID || '';
const VEV_GROUP_ID = import.meta.env.VITE_VEV_GROUP_ID || '';
const VEV_REGION = import.meta.env.VITE_VEV_REGION || 'cn-north-1';
const VEV_DEFAULT_CLASSIFICATION_ID = import.meta.env.VITE_VEV_DEFAULT_CLASSIFICATION_ID || '';
const VEV_UPLOAD_WORKFLOW_TEMPLATE_ID = String(import.meta.env.VITE_VEV_UPLOAD_WORKFLOW_TEMPLATE_ID || '').trim();
const ORIGIN_BRIDGE_VERSION = 'origin-vevdemo-bridge-v1';
const LOCAL_UPLOAD_AUTOCONFIRM_CLASS = 'origin-vevdemo-upload-autoconfirm';
const LOCAL_UPLOAD_AUTOCONFIRM_MASK_CLASS = 'origin-vevdemo-upload-autoconfirm-mask';
const MATERIAL_SELECTOR_DIALOG_CLASS = 'origin-vevdemo-material-selector-dialog';
const MATERIAL_SELECTOR_BODY_CLASS = 'origin-vevdemo-material-selector-body';
const MATERIAL_SELECTOR_PAGINATION_CLASS = 'origin-vevdemo-material-selector-pagination';
const SUBTITLE_MATERIAL_CARD_CLASS = 'origin-vevdemo-subtitle-material-card';
const SUBTITLE_MATERIAL_THUMB_CLASS = 'origin-vevdemo-subtitle-material-thumb';
const SUBTITLE_MATERIAL_LABEL_RE = /\borigin-subtitles-[\w-]+-v\d+\.(?:srt|vtt|ass)\b/i;
const CUT_TOOLBAR_SELECTOR = '.toolsBar-NbkSYr .left-DP9tfU .iconWrapper-iB9U7K';
const CUT_TOOLBAR_INDEX = 2;
const CUT_TOOLBAR_ACTIVE_CLASS = 'active-ZEWa0z';
const BRIDGE_READY_RETRY_MS = 500;
const BRIDGE_READY_RETRY_MAX = 8;
const VEV_CLOCK_LABEL_PATTERN = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const VEV_CLOCK_LABEL_MAX_TEXT_LENGTH = 80;
const VEV_DURATION_LABEL_SCAN_LIMIT = 500;

let veveditorInstance = null;
let activeVevProjectId = VEV_PROJECT_ID;
let activeVevGroupId = VEV_GROUP_ID;
let activeOriginProjectId = '';
let activeOriginProjectTitle = '';
let lastAppliedOriginProjectTitle = '';
let titleSyncInFlight = null;
let originRequestSeq = 0;
const originRequests = new Map();
const localUploadDialogSeenAt = new WeakMap();
const localUploadDialogClickedAt = new WeakMap();
let localUploadAutoConfirmTimer = null;
let cutAutoSelectRetrying = false;
let bridgeReadyRetryTimer = null;
let bridgeReadyRetryCount = 0;
const originMaterialTitleCache = {
  projectId: '',
  expiresAt: 0,
  promise: null,
  byTaskId: new Map(),
  bySource: new Map(),
  byEditMid: new Map(),
  byVid: new Map(),
  latestSubtitleTitle: '',
};
const persistentOriginMaterialTitleItems = new Map();
let originMaterialNamePolisherInstalled = false;
let originMaterialNamePolishTimer = null;
let originSubtitleMaterialCardTimer = null;
let materialSelectorPaginationDockInstalled = false;
let materialSelectorPaginationDockTimer = null;

function getElementText(element) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function looksLikeLocalUploadDialog(element) {
  const text = getElementText(element);
  return text.includes('素材上传')
    && text.includes('素材名称')
    && text.includes('格式')
    && text.includes('大小')
    && (text.includes('存储空间') || text.includes('点击或拖拽文件到此处上传'));
}

function findLocalUploadDialog() {
  const selectors = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.arco-modal',
    '.arco-modal-wrapper',
    '.semi-modal',
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="dialog"]',
    '[class*="Dialog"]',
  ];
  const candidates = new Set();
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => candidates.add(element));
  });
  for (const candidate of candidates) {
    const dialog = candidate.closest?.('[role="dialog"], [aria-modal="true"], .arco-modal, .arco-modal-wrapper, .semi-modal, [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]') || candidate;
    if (looksLikeLocalUploadDialog(dialog)) return dialog;
  }
  return null;
}

function findLocalUploadConfirmButton(dialog) {
  const controls = Array.from(dialog.querySelectorAll('button, [role="button"]'));
  return controls.find((control) => {
    const text = getElementText(control);
    const disabled = Boolean(control.disabled)
      || control.getAttribute('aria-disabled') === 'true'
      || control.classList.contains('disabled');
    return !disabled && (text === '确定' || text === '上传');
  });
}

function getLocalUploadDialogRoot(dialog) {
  return dialog.closest?.('.arco-modal-wrapper, [class*="modal-wrap"], [class*="ModalWrap"], [class*="dialog-wrap"], [class*="DialogWrap"], [role="dialog"], [aria-modal="true"], .arco-modal, .semi-modal') || dialog;
}

function hideLocalUploadDialog(dialog) {
  const root = getLocalUploadDialogRoot(dialog);
  root.classList.add(LOCAL_UPLOAD_AUTOCONFIRM_CLASS);
  document.querySelectorAll('[class*="mask"], [class*="Mask"]').forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5) {
      element.classList.add(LOCAL_UPLOAD_AUTOCONFIRM_MASK_CLASS);
    }
  });
}

function clearLocalUploadHiddenState() {
  document.querySelectorAll(`.${LOCAL_UPLOAD_AUTOCONFIRM_CLASS}, .${LOCAL_UPLOAD_AUTOCONFIRM_MASK_CLASS}`).forEach((element) => {
    element.classList.remove(LOCAL_UPLOAD_AUTOCONFIRM_CLASS, LOCAL_UPLOAD_AUTOCONFIRM_MASK_CLASS);
  });
}

function injectLocalUploadAutoConfirmStyle() {
  if (document.getElementById('origin-vevdemo-local-upload-autoconfirm-style')) return;
  const style = document.createElement('style');
  style.id = 'origin-vevdemo-local-upload-autoconfirm-style';
  style.textContent = `
    .${LOCAL_UPLOAD_AUTOCONFIRM_CLASS},
    .${LOCAL_UPLOAD_AUTOCONFIRM_MASK_CLASS} {
      opacity: 0 !important;
      pointer-events: none !important;
      transition: none !important;
      animation: none !important;
    }
  `;
  document.head.appendChild(style);
}

function scanLocalUploadDialog() {
  const dialog = findLocalUploadDialog();
  if (!dialog) {
    clearLocalUploadHiddenState();
    return false;
  }
  if (!localUploadDialogSeenAt.has(dialog)) {
    localUploadDialogSeenAt.set(dialog, Date.now());
  }
  const confirmButton = findLocalUploadConfirmButton(dialog);
  const seenMs = Date.now() - localUploadDialogSeenAt.get(dialog);
  if (confirmButton || seenMs < 2500) {
    hideLocalUploadDialog(dialog);
  }
  if (!confirmButton) {
    scheduleLocalUploadAutoConfirm(120);
    return true;
  }
  const clickedAt = localUploadDialogClickedAt.get(dialog) || 0;
  if (Date.now() - clickedAt > 2000) {
    localUploadDialogClickedAt.set(dialog, Date.now());
    confirmButton.click();
    console.log('[VevDemoBridge] auto confirmed local material upload dialog');
    window.setTimeout(clearLocalUploadHiddenState, 1000);
  }
  return true;
}

function scheduleLocalUploadAutoConfirm(delay = 0) {
  if (localUploadAutoConfirmTimer) {
    window.clearTimeout(localUploadAutoConfirmTimer);
  }
  localUploadAutoConfirmTimer = window.setTimeout(() => {
    localUploadAutoConfirmTimer = null;
    scanLocalUploadDialog();
  }, delay);
}

function installLocalUploadAutoConfirm() {
  if (window.__originVevDemoLocalUploadAutoConfirmInstalled) return;
  window.__originVevDemoLocalUploadAutoConfirmInstalled = true;
  injectLocalUploadAutoConfirmStyle();
  const observer = new MutationObserver(() => {
    scheduleLocalUploadAutoConfirm();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled'],
  });
  scheduleLocalUploadAutoConfirm();
}

function looksLikeMaterialSelectorDialog(element) {
  const text = getElementText(element);
  return text.includes('添加素材')
    && text.includes('视频库')
    && (text.includes('请输入Vid') || text.includes('请输入Mid') || text.includes('请输入名称'));
}

function findMaterialSelectorDialogs() {
  const selectors = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.arco-modal',
    '.arco-modal-wrapper',
    '.semi-modal',
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="dialog"]',
    '[class*="Dialog"]',
  ];
  const candidates = new Set();
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => candidates.add(element));
  });
  return Array.from(candidates)
    .map((candidate) => candidate.closest?.('[role="dialog"], [aria-modal="true"], .arco-modal, .arco-modal-wrapper, .semi-modal, [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]') || candidate)
    .filter((candidate, index, list) => list.indexOf(candidate) === index)
    .filter(looksLikeMaterialSelectorDialog);
}

function injectMaterialSelectorPaginationDockStyle() {
  if (document.getElementById('origin-vevdemo-material-selector-pagination-style')) return;
  const style = document.createElement('style');
  style.id = 'origin-vevdemo-material-selector-pagination-style';
  style.textContent = `
    .${MATERIAL_SELECTOR_DIALOG_CLASS} .${MATERIAL_SELECTOR_BODY_CLASS} {
      position: relative !important;
      min-height: 540px !important;
      padding-bottom: 76px !important;
      box-sizing: border-box !important;
    }

    .${MATERIAL_SELECTOR_DIALOG_CLASS} .${MATERIAL_SELECTOR_PAGINATION_CLASS} {
      position: absolute !important;
      right: 32px !important;
      bottom: 24px !important;
      margin: 0 !important;
      z-index: 3 !important;
      justify-content: flex-end !important;
    }
  `;
  document.head.appendChild(style);
}

function findMaterialSelectorBody(dialog, pagination) {
  return pagination.closest?.('.arco-modal-body, [class*="modal-body"], [class*="ModalBody"]')
    || dialog.querySelector?.('.arco-modal-body, [class*="modal-body"], [class*="ModalBody"]')
    || dialog;
}

function scanMaterialSelectorPaginationDock() {
  findMaterialSelectorDialogs().forEach((dialog) => {
    dialog.classList.add(MATERIAL_SELECTOR_DIALOG_CLASS);
    const paginations = Array.from(dialog.querySelectorAll('[class*="pagination"], [class*="Pagination"]'));
    paginations.forEach((pagination) => {
      if (!pagination.querySelector?.('li, button, [role="button"]')) return;
      const body = findMaterialSelectorBody(dialog, pagination);
      body.classList.add(MATERIAL_SELECTOR_BODY_CLASS);
      pagination.classList.add(MATERIAL_SELECTOR_PAGINATION_CLASS);
    });
  });
}

function scheduleMaterialSelectorPaginationDock(delay = 0) {
  if (materialSelectorPaginationDockTimer) window.clearTimeout(materialSelectorPaginationDockTimer);
  materialSelectorPaginationDockTimer = window.setTimeout(() => {
    materialSelectorPaginationDockTimer = null;
    scanMaterialSelectorPaginationDock();
  }, delay);
}

function installMaterialSelectorPaginationDock() {
  if (materialSelectorPaginationDockInstalled) return;
  materialSelectorPaginationDockInstalled = true;
  injectMaterialSelectorPaginationDockStyle();
  const observer = new MutationObserver(() => scheduleMaterialSelectorPaginationDock(40));
  const start = () => {
    if (!document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    scheduleMaterialSelectorPaginationDock();
  };
  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
}

function flattenVevTrackItems(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenVevTrackItems(item, out));
    return out;
  }
  if (typeof value !== 'object') return out;
  if (value.ID && Array.isArray(value.TargetTime)) {
    out.push(value);
    return out;
  }
  Object.values(value).forEach((item) => flattenVevTrackItems(item, out));
  return out;
}

function getVevEditorProjectData() {
  try {
    return veveditorInstance?.editor?.projectData || null;
  } catch (err) {
    console.warn('[VevDemoBridge] failed to read editor projectData:', err);
    return null;
  }
}

function getVevEditorCurrentTime() {
  const currentTime = Number(veveditorInstance?.editor?.currentTime);
  return Number.isFinite(currentTime) ? currentTime : null;
}

function getVevEditorDuration() {
  const duration = Number(veveditorInstance?.editor?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function getTrackComparisonTime(items, currentTime) {
  const maxEnd = items.reduce((max, item) => {
    const end = Number(item?.TargetTime?.[1]);
    return Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0);
  const duration = getVevEditorDuration();
  if (!duration || !Number.isFinite(currentTime)) return currentTime;
  if (maxEnd > duration * 100000) return currentTime * 1000000;
  if (maxEnd > duration * 50) return currentTime * 1000;
  return currentTime;
}

function getCutToolbarButton() {
  const buttons = Array.from(document.querySelectorAll(CUT_TOOLBAR_SELECTOR));
  return buttons[CUT_TOOLBAR_INDEX] || null;
}

function findCutToolbarButtonFromTarget(target) {
  const button = getCutToolbarButton();
  if (!button || !(target instanceof Element)) return null;
  return button === target || button.contains(target) ? button : null;
}

function isCutToolbarButtonActive(button) {
  return Boolean(button?.classList?.contains(CUT_TOOLBAR_ACTIVE_CLASS));
}

function findTrackItemAtCurrentTime() {
  const currentTime = getVevEditorCurrentTime();
  if (currentTime == null) return null;
  const track = getVevEditorProjectData()?.LatestEditParam?.Track;
  const items = flattenVevTrackItems(track);
  const comparisonTime = getTrackComparisonTime(items, currentTime);
  return items.find((item) => {
    const start = Number(item.TargetTime?.[0]);
    const end = Number(item.TargetTime?.[1]);
    return item.ID && Number.isFinite(start) && Number.isFinite(end) && comparisonTime > start && comparisonTime < end;
  }) || null;
}

function getElementForTrackItem(item) {
  const ids = [
    item?.UserData?.id,
    item?.UserData?.ID,
    item?.ID,
    item?.id,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) return element;
  }
  return null;
}

function findTrackElementAtPointer() {
  const pointer = document.querySelector('.vc-time-pointer-line, .vc-time-pointer-arrow');
  const pointerRect = pointer?.getBoundingClientRect?.();
  if (!pointerRect || !pointerRect.width) return null;
  const pointerX = pointerRect.left + pointerRect.width / 2;
  const candidates = Array.from(document.querySelectorAll('.vc-material')).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && pointerX > rect.left + 1
      && pointerX < rect.right - 1;
  });
  candidates.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return bRect.height - aRect.height || aRect.top - bRect.top;
  });
  return candidates[0] || null;
}

function findTrackSelectionTargetAtCurrentTime() {
  const item = findTrackItemAtCurrentTime();
  const element = getElementForTrackItem(item) || findTrackElementAtPointer();
  return element ? { element, item } : null;
}

function selectVevTrackElement(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const clientX = rect.left + Math.min(Math.max(rect.width / 2, 8), Math.max(rect.width - 8, 8));
  const clientY = rect.top + rect.height / 2;
  element.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    view: window,
    buttons: 1,
    clientX,
    clientY,
  }));
  document.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
  }));
  return true;
}

function retryCutToolbarClick(attempt = 0) {
  const button = getCutToolbarButton();
  if (!button) {
    cutAutoSelectRetrying = false;
    return;
  }
  if (!isCutToolbarButtonActive(button) && attempt < 5) {
    window.setTimeout(() => retryCutToolbarClick(attempt + 1), 40);
    return;
  }
  try {
    button.click();
  } finally {
    window.setTimeout(() => {
      cutAutoSelectRetrying = false;
    }, 0);
  }
}

function handleCutToolbarClick(event) {
  const button = findCutToolbarButtonFromTarget(event.target);
  if (!button || cutAutoSelectRetrying || isCutToolbarButtonActive(button)) return;

  const target = findTrackSelectionTargetAtCurrentTime();
  if (!target) {
    postToOrigin('vevdemo:status', {
      status: 'cut-disabled',
      reason: 'no_track_item_at_current_time',
      currentTime: getVevEditorCurrentTime(),
      ...getBridgeState(),
    });
    return;
  }
  if (!selectVevTrackElement(target.element)) {
    postToOrigin('vevdemo:status', {
      status: 'cut-disabled',
      reason: 'track_item_dom_not_found',
      currentTime: getVevEditorCurrentTime(),
      itemId: target.item?.ID || target.element?.id || null,
      ...getBridgeState(),
    });
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  cutAutoSelectRetrying = true;
  postToOrigin('vevdemo:status', {
    status: 'cut-auto-select',
    currentTime: getVevEditorCurrentTime(),
    itemId: target.item?.ID || target.element?.id || null,
    ...getBridgeState(),
  });
  window.setTimeout(() => retryCutToolbarClick(), 40);
}

function installCutAutoSelectFallback() {
  if (window.__originVevDemoCutAutoSelectInstalled) return;
  window.__originVevDemoCutAutoSelectInstalled = true;
  document.addEventListener('click', handleCutToolbarClick, true);
}

function getOriginBridgeTarget() {
  try {
    return document.referrer ? new URL(document.referrer).origin : '*';
  } catch (err) {
    return '*';
  }
}

function postToOrigin(type, data = {}) {
  if (!window.parent || window.parent === window) return;
  window.parent.postMessage({
    type,
    data: {
      ...data,
      bridgeVersion: ORIGIN_BRIDGE_VERSION,
      timestamp: Date.now(),
    },
  }, getOriginBridgeTarget());
}

function requestOrigin(requestType, payload = {}, timeoutMs = 12000) {
  if (!window.parent || window.parent === window) {
    return Promise.reject(new Error('Origin parent window is not available'));
  }
  const requestId = `origin-req-${Date.now()}-${++originRequestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      originRequests.delete(requestId);
      reject(new Error(`Origin request timeout: ${requestType}`));
    }, timeoutMs);
    originRequests.set(requestId, { resolve, reject, timer, requestType });
    postToOrigin('vevdemo:originRequest', {
      requestId,
      requestType,
      payload,
    });
  });
}

function handleOriginResponse(data = {}) {
  const requestId = String(data.requestId || '').trim();
  const pending = originRequests.get(requestId);
  if (!pending) return false;
  originRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (data.ok === false) {
    pending.reject(new Error(data.error || `Origin request failed: ${pending.requestType}`));
  } else {
    pending.resolve(data.result);
  }
  return true;
}

function isProjectIsolationReady() {
  return Boolean(activeVevProjectId && activeVevProjectId !== VEV_PROJECT_ID);
}

function isAwaitingProjectBinding() {
  return !veveditorInstance && !isProjectIsolationReady();
}

function getBridgeState() {
  return {
    ready: !!veveditorInstance,
    originProjectId: activeOriginProjectId || null,
    originTitle: activeOriginProjectTitle || '',
    projectId: activeVevProjectId || VEV_PROJECT_ID,
    groupId: activeVevGroupId || VEV_GROUP_ID,
    region: VEV_REGION,
    uploadWorkflowConfigured: Boolean(VEV_UPLOAD_WORKFLOW_TEMPLATE_ID),
    projectIsolationReady: isProjectIsolationReady(),
    awaitingProjectBinding: isAwaitingProjectBinding(),
  };
}

function notifyOriginReady() {
  postToOrigin('vevdemo:ready', getBridgeState());
}

function clearBridgeReadyRetryTimer() {
  if (bridgeReadyRetryTimer) {
    window.clearTimeout(bridgeReadyRetryTimer);
    bridgeReadyRetryTimer = null;
  }
}

function stopBridgeReadyAnnounce() {
  clearBridgeReadyRetryTimer();
  bridgeReadyRetryCount = BRIDGE_READY_RETRY_MAX;
}

function announceBridgeReady() {
  if (!isAwaitingProjectBinding()) return;
  postToOrigin('vevdemo:status', {
    status: 'bridge-ready',
    bridgeReady: true,
    awaitingProjectBinding: true,
    ...getBridgeState(),
  });
  if (bridgeReadyRetryCount >= BRIDGE_READY_RETRY_MAX) return;
  bridgeReadyRetryCount += 1;
  clearBridgeReadyRetryTimer();
  bridgeReadyRetryTimer = window.setTimeout(announceBridgeReady, BRIDGE_READY_RETRY_MS);
}

function findVisibleProjectTitleNode() {
  const header = document.querySelector('.veveditor-vod-layout-header');
  if (!header) return null;
  const center = Array.from(header.querySelectorAll('div, section')).find((el) => {
    const className = String(el.className || '');
    if (!className.includes('center')) return false;
    const rect = el.getBoundingClientRect();
    return rect.top < 80;
  }) || Array.from((header.querySelector('section') || header).children)[1] || null;
  if (!center) return null;
  return center.querySelector('.c-m-inline-edit')
    || center.querySelector('[class*="inline-edit"]')
    || center.firstElementChild
    || center;
}

function applyVisibleOriginProjectTitle(title) {
  const nextTitle = String(title || '').trim();
  if (!nextTitle) return false;
  const titleNode = findVisibleProjectTitleNode();
  if (!titleNode) return false;
  if (titleNode.textContent !== nextTitle) {
    titleNode.textContent = nextTitle;
  }
  titleNode.setAttribute('title', nextTitle);
  titleNode.setAttribute('aria-label', nextTitle);
  if (titleNode.isContentEditable) titleNode.contentEditable = 'false';
  return true;
}

function scheduleVisibleOriginProjectTitle(title) {
  const nextTitle = String(title || '').trim();
  if (!nextTitle) return;
  [0, 80, 250, 700, 1500, 3000].forEach((delay) => {
    window.setTimeout(() => applyVisibleOriginProjectTitle(nextTitle), delay);
  });
}

function buildNamedEditParam(editParam, title) {
  const now = Date.now();
  const next = editParam && typeof editParam === 'object' && !Array.isArray(editParam)
    ? { ...editParam }
    : {};
  const projectMeta = next.Project && typeof next.Project === 'object' && !Array.isArray(next.Project)
    ? { ...next.Project }
    : {};
  projectMeta.Name = title;
  projectMeta.UpdateTime = now;
  if (!projectMeta.CreateTime) projectMeta.CreateTime = now;
  next.Project = projectMeta;

  const uploadMeta = next.Upload && typeof next.Upload === 'object' && !Array.isArray(next.Upload)
    ? { ...next.Upload }
    : {};
  uploadMeta.VideoName = title;
  next.Upload = uploadMeta;
  return next;
}

async function applyOriginProjectTitle(title) {
  const nextTitle = String(title || '').trim();
  if (!nextTitle || !activeVevProjectId || !activeVevGroupId) return null;
  if (nextTitle === lastAppliedOriginProjectTitle) return null;
  if (titleSyncInFlight) {
    try { await titleSyncInFlight; } catch (_) {}
    if (nextTitle === lastAppliedOriginProjectTitle) return null;
  }

  titleSyncInFlight = (async () => {
    const projectInfo = await describeProject({ ProjectId: activeVevProjectId, GroupId: activeVevGroupId });
    const editParam = normalizeEditParamFromProject(projectInfo);
    const nextEditParam = buildNamedEditParam(editParam, nextTitle);
    const rawEditParam = readFirst({ projectInfo }, ['projectInfo.EditParam', 'projectInfo.LatestEditParam']);
    const editParamPayload = typeof rawEditParam === 'string' ? JSON.stringify(nextEditParam) : nextEditParam;
    const result = await updateProject({
      ProjectId: activeVevProjectId,
      GroupId: activeVevGroupId,
      ProjectName: nextTitle,
      EditParam: editParamPayload,
    });
    lastAppliedOriginProjectTitle = nextTitle;
    postToOrigin('vevdemo:status', {
      status: 'origin-project-title-updated',
      originTitle: nextTitle,
      updateResult: result,
      ...getBridgeState(),
    });
    return result;
  })();

  try {
    return await titleSyncInFlight;
  } catch (err) {
    console.warn('[VevDemoBridge] apply Origin project title failed:', err);
    postToOrigin('vevdemo:status', {
      status: 'origin-project-title-update-failed',
      originTitle: nextTitle,
      message: err?.message || String(err || 'unknown error'),
      ...getBridgeState(),
    });
    return null;
  } finally {
    titleSyncInFlight = null;
  }
}

function probeMediaElement(material) {
  return new Promise((resolve) => {
    const url = material?.url || '';
    if (!url) {
      resolve({ id: material?.id, ok: false, reason: 'missing_url' });
      return;
    }
    const kind = String(material?.type || '').toLowerCase();
    const isImage = kind === 'image' || /\.(png|jpe?g|webp|gif|svg)(\?|#|$)/i.test(url);
    const isAudio = kind === 'audio' || /\.(mp3|wav|m4a|aac|ogg)(\?|#|$)/i.test(url);
    const el = isImage ? new Image() : document.createElement(isAudio ? 'audio' : 'video');
    let done = false;
    const cleanup = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      cleanup({ id: material?.id, ok: false, url, reason: 'timeout' });
    }, 8000);
    if (isImage) {
      el.onload = () => cleanup({ id: material?.id, ok: true, url, type: 'image' });
      el.onerror = () => cleanup({ id: material?.id, ok: false, url, type: 'image', reason: 'load_error' });
      el.src = url;
      return;
    }
    el.preload = 'metadata';
    el.muted = true;
    el.playsInline = true;
    el.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    el.onloadedmetadata = () => cleanup({
      id: material?.id,
      ok: true,
      url,
      type: isAudio ? 'audio' : 'video',
      duration: Number.isFinite(el.duration) ? el.duration : null,
    });
    el.onerror = () => cleanup({
      id: material?.id,
      ok: false,
      url,
      type: isAudio ? 'audio' : 'video',
      reason: 'load_error',
    });
    document.body.appendChild(el);
    el.src = url;
    try { el.load(); } catch (_) {}
  });
}

async function handleOriginImportMaterials(materials) {
  const list = Array.isArray(materials) ? materials : [];
  list.forEach(rememberOriginMaterialTitle);
  scheduleOriginMaterialNamePolish();
  const total = list.length;
  let doneCount = 0;
  const reportImportProgress = () => postToOrigin('vevdemo:status', {
    status: 'import-progress',
    done: doneCount,
    total,
    ...getBridgeState(),
  });
  if (total > 0) reportImportProgress();
  const pairs = await Promise.all(list.map(async (material) => {
    const [probe, registration] = await Promise.all([
      probeMediaElement(material),
      registerOriginMaterialToVevDemo(material),
    ]);
    doneCount += 1;
    reportImportProgress();
    return { probe, registration };
  }));
  const probeResults = pairs.map((item) => item.probe);
  const registrationResults = pairs.map((item) => item.registration);
  const okResults = probeResults.filter((item) => item.ok);
  const registeredResults = registrationResults.filter((item) => item.ok);
  postToOrigin('vevdemo:materialsImported', {
    mode: registeredResults.length > 0 ? 'create-edit-material' : 'browser-url-probe',
    count: registeredResults.length || okResults.length,
    registeredCount: registeredResults.length,
    probedCount: okResults.length,
    mediaIds: registeredResults.length > 0
      ? registeredResults.map((item) => item.editMid || item.id).filter(Boolean)
      : okResults.map((item) => item.id).filter(Boolean),
    results: probeResults,
    registrationResults,
    cloudReachable: registeredResults.length > 0,
  });
}

function isSupportedVevSource(source) {
  return /^(vid|mid|directurl|tos):\/\//i.test(String(source || '').trim());
}

function buildCreateEditMaterialPayload(material) {
  if (material && typeof material.vevCreatePayload === 'object' && !Array.isArray(material.vevCreatePayload)) {
    return material.vevCreatePayload;
  }
  const source = String(material?.vevSource || material?.source || '').trim();
  if (!isSupportedVevSource(source)) return null;
  const projectId = String(material?.vevProjectId || '').trim();
  if (!projectId) {
    console.warn('[VevDemoBridge] blocked material registration without project id:', material?.id || material?.name || material?.title || '');
    return null;
  }
  return {
    ProjectId: projectId,
    Space: material?.vevSpace || material?.space || 'origin',
    Name: material?.title || material?.name || material?.filename || material?.id || 'origin-material',
    Type: String(material?.type || 'video').toLowerCase(),
    Source: source,
  };
}

async function registerOriginMaterialToVevDemo(material) {
  if (material?.vevEditMid) {
    return {
      id: material?.id,
      ok: true,
      editMid: material.vevEditMid,
      reason: 'already_registered',
      vevRegistrationReady: Boolean(material?.vevRegistrationReady),
    };
  }
  const payload = buildCreateEditMaterialPayload(material);
  if (!payload) {
    return {
      id: material?.id,
      ok: false,
      reason: material?.vevRegistrationReason || 'unsupported_vev_source',
      vevRegistrationReady: Boolean(material?.vevRegistrationReady),
    };
  }
  try {
    const findRegisteredMaterial = async () => {
      const search = await searchEditMaterial({
        ProjectId: payload.ProjectId,
        Space: payload.Space,
      });
      const list =
        search?.Detail ||
        search?.MaterialInfoList ||
        search?.EditMaterialList ||
        search?.MaterialList ||
        [];
      return Array.isArray(list)
        ? list.find((item) => String(item?.Source || '').trim() === String(payload.Source || '').trim())
        : null;
    };

    const result = await createEditMaterial(payload);
    const editMid = readFirst({ result }, ['result.EditMid', 'result.editMid', 'result.MaterialId', 'result.materialId', 'result.Id', 'result.id']);
    const registered = editMid ? null : await findRegisteredMaterial();
    const finalEditMid = editMid || registered?.EditMid || registered?.editMid || registered?.MaterialId || registered?.Id || '';
    if (!finalEditMid) {
      return {
        id: material?.id,
        ok: false,
        payload,
        result: registered ? { create: result, search: registered } : result,
        reason: 'create_edit_material_missing_edit_mid',
      };
    }
    return {
      id: material?.id,
      ok: true,
      editMid: finalEditMid,
      payload,
      result: registered ? { create: result, search: registered } : result,
    };
  } catch (err) {
    return {
      id: material?.id,
      ok: false,
      payload,
      reason: err?.message || 'create_edit_material_failed',
    };
  }
}

function readFirst(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((cur, key) => (cur && cur[key] !== undefined ? cur[key] : undefined), source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function readEditMaterialSource(item) {
  return String(readFirst({ item }, [
    'item.Source',
    'item.source',
    'item.BasicInfo.Source',
    'item.SourceInfo.Source',
    'item.MaterialInfo.Source',
  ]) || '').trim();
}

function readEditMaterialMid(item) {
  return String(readFirst({ item }, [
    'item.EditMid',
    'item.editMid',
    'item.MaterialId',
    'item.materialId',
    'item.Id',
    'item.id',
  ]) || '').trim();
}

function createEditMaterialResultFromExisting(item) {
  const editMid = readEditMaterialMid(item);
  return {
    ...item,
    EditMid: editMid,
    editMid,
    MaterialId: item?.MaterialId || editMid,
    Id: item?.Id || editMid,
    OriginReusedBySource: true,
  };
}

// 2026-06-11 探针实证：SDK「从系统导入」点确定时不走 getVideoInfo，而是对每个勾选项
// 直接 createEditMaterial({ Source: 'vid://<列表Vid>' })。列表 Vid 是合成的
// origin-video-task:<taskId>，对 VOD 不存在 → OpenAPI 静默失败（Result=undefined）→
// SDK 拿不到 EditMid，素材区不出现任何东西（添加素材弹窗问题4的根因）。
// 这里识别合成 Source，转走已验证的注册链（registerProjectVideo → /api/volcengine/import，
// 幂等、盖 vevProjectId），再拼回 CreateEditMaterial 兼容形状还给 SDK。
function extractOriginTaskIdFromVevSource(source) {
  const vid = extractVidFromVevSource(source);
  return isOriginVideoSyntheticVid(vid) ? vid.slice('origin-video-task:'.length) : '';
}

async function createEditMaterialViaOriginRegistration(videoTaskId, params = {}) {
  const payload = await requestOrigin('registerProjectVideo', {
    projectId: activeOriginProjectId,
    videoTaskId,
  }, 15 * 60 * 1000);
  const materials = Array.isArray(payload?.materials) ? payload.materials : [];
  const material = materials.find((item) => String(item?.id || '') === videoTaskId) || materials[0] || null;
  const editMid = String(material?.vevEditMid || '').trim();
  if (!editMid) {
    throw new Error(`Origin 注册未返回 EditMid（注册可能仍在进行，稍后重试）: ${videoTaskId}`);
  }
  try { rememberOriginMaterialTitle(material, { persist: true }); } catch (_) { /* 名字保真失败不阻断 */ }
  return {
    EditMid: editMid,
    editMid,
    MaterialId: editMid,
    Id: editMid,
    Source: String(material?.vevSource || '').trim() || undefined,
    Name: material?.title || params?.Name,
    OriginRegisteredViaImport: true,
  };
}

async function createOrReuseOriginEditMaterial(params = {}) {
  const source = String(params?.Source || params?.source || '').trim();
  const requestedProjectId = String(params?.ProjectId || params?.projectId || '').trim();
  const projectId = requestedProjectId || activeVevProjectId;
  const space = String(params?.Space || params?.space || 'origin').trim() || 'origin';
  const payload = {
    ...params,
    ProjectId: projectId,
    Space: space,
  };

  if (isProjectIsolationReady() && projectId !== activeVevProjectId) {
    throw new Error(`CreateEditMaterial project mismatch: ${projectId || '(empty)'} !== ${activeVevProjectId}`);
  }

  const syntheticTaskId = extractOriginTaskIdFromVevSource(source);
  if (syntheticTaskId) {
    return await createEditMaterialViaOriginRegistration(syntheticTaskId, params);
  }

  if (source && projectId) {
    const search = await searchEditMaterial({ ProjectId: projectId, Space: space });
    const existing = editMaterialListFromSearchResult(search).find((item) => readEditMaterialSource(item) === source);
    if (existing) {
      return createEditMaterialResultFromExisting(existing);
    }
  }

  return createEditMaterial(payload);
}

function extractVidFromVevSource(source) {
  const match = /^vid:\/\/(.+)$/i.exec(String(source || '').trim());
  return match ? match[1] : '';
}

function originVideoSyntheticVid(videoTaskId) {
  return `origin-video-task:${String(videoTaskId || '').trim()}`;
}

function isOriginVideoSyntheticVid(vid) {
  return String(vid || '').startsWith('origin-video-task:');
}

function readOriginVideoTaskId(params = {}) {
  const direct = params.originVideoTaskId || params.OriginVideoTaskId || params.videoTaskId || params.resourceId;
  if (direct) return String(direct).trim();
  const vid = String(params.Vid || params.vid || '').trim();
  return isOriginVideoSyntheticVid(vid) ? vid.slice('origin-video-task:'.length) : '';
}

function readSearchKeyword(params = {}) {
  return String(params.Keyword || params.keyword || params.Title || params.title || '').trim().toLowerCase();
}

function matchesOriginVideoSearch(item, keyword) {
  if (!keyword) return true;
  return [
    item?.title,
    item?.name,
    item?.id,
    item?.taskId,
    item?.prompt,
    item?.groupIdx,
  ].some((value) => String(value || '').toLowerCase().includes(keyword));
}

function getOriginParentOrigin() {
  try {
    return document.referrer ? new URL(document.referrer).origin : '';
  } catch {
    return '';
  }
}

function toOriginAbsoluteUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    return new URL(value, getOriginParentOrigin() || window.location.origin).toString();
  } catch {
    return value;
  }
}

function toIntegerDurationSeconds(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.floor(duration);
}

function formatMinuteSecond(value) {
  const total = toIntegerDurationSeconds(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeVevClockLabel(value) {
  const text = String(value || '').trim();
  const match = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text);
  if (!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  if (![hours, minutes, seconds, fraction].every(Number.isFinite)) return '';
  return formatMinuteSecond((hours * 3600) + (minutes * 60) + seconds + fraction);
}

function normalizeVevClockText(value) {
  const text = String(value ?? '');
  if (!/\d{1,2}:\d{2}:\d{2}/.test(text)) return '';
  const nextText = text.replace(VEV_CLOCK_LABEL_PATTERN, (match) => normalizeVevClockLabel(match) || match);
  return nextText !== text ? nextText : '';
}

function findOriginCoverUrl(item) {
  return toOriginAbsoluteUrl(
    item?.coverUrl ||
    item?.cover_url ||
    item?.posterUrl ||
    item?.poster_url ||
    item?.PosterUrl ||
    item?.PosterURL ||
    item?.CoverUrl ||
    item?.CoverURL ||
    item?.thumbnailUrl ||
    item?.thumbnail_url ||
    item?.imageUrl ||
    item?.image_url ||
    ''
  );
}

function canNormalizeVevDurationTextNode(node) {
  const text = String(node?.nodeValue || '');
  if (!text || text.length > VEV_CLOCK_LABEL_MAX_TEXT_LENGTH) return false;
  const parent = node?.parentElement || null;
  if (!parent) return false;
  const tagName = String(parent.tagName || '').toLowerCase();
  if (['script', 'style', 'noscript', 'textarea', 'input', 'select', 'option'].includes(tagName)) return false;
  if (parent.isContentEditable || parent.closest?.('[contenteditable="true"], [contenteditable=""], [role="textbox"]')) return false;
  return true;
}

function normalizeVevDurationLabels(root = document.body) {
  if (!root) return 0;
  const normalizeNode = (node) => {
    if (!canNormalizeVevDurationTextNode(node)) return false;
    const nextText = normalizeVevClockText(node.nodeValue);
    if (!nextText) return false;
    node.nodeValue = nextText;
    return true;
  };

  if (root.nodeType === Node.TEXT_NODE) return normalizeNode(root) ? 1 : 0;
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return 0;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let changed = 0;
  let node = walker.nextNode();
  while (node && changed < VEV_DURATION_LABEL_SCAN_LIMIT) {
    if (normalizeNode(node)) changed += 1;
    node = walker.nextNode();
  }
  return changed;
}

function installVevDurationLabelPolish() {
  if (window.__originVevDurationLabelPolishInstalled) return;
  if (!document.body) {
    window.addEventListener('DOMContentLoaded', installVevDurationLabelPolish, { once: true });
    return;
  }
  window.__originVevDurationLabelPolishInstalled = true;
  const pendingTargets = new Set([document.body]);
  let pending = false;
  const enqueue = (target) => {
    const root = target?.nodeType === Node.TEXT_NODE
      ? target.parentElement
      : (target?.nodeType === Node.ELEMENT_NODE || target?.nodeType === Node.DOCUMENT_NODE ? target : null);
    if (root) pendingTargets.add(root);
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const roots = Array.from(pendingTargets);
      pendingTargets.clear();
      roots.forEach((root) => normalizeVevDurationLabels(root));
    });
  };
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'characterData') {
        enqueue(mutation.target);
        return;
      }
      enqueue(mutation.target);
      mutation.addedNodes?.forEach((node) => enqueue(node));
    });
    schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  schedule();
}

function isEditableShortcutTarget(target) {
  const element = target instanceof Element ? target : target?.parentElement || null;
  if (!element) return false;
  const tagName = String(element.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tagName)) return true;
  return Boolean(element.isContentEditable || element.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'));
}

function isVisibleElement(element) {
  if (!(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
}

function hasVisibleBlockingDialog() {
  return Array.from(document.querySelectorAll([
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.arco-modal',
    '.arco-modal-wrapper',
    '.semi-modal',
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="dialog"]',
    '[class*="Dialog"]',
  ].join(','))).some((element) => {
    if (!isVisibleElement(element)) return false;
    const text = getElementText(element);
    return text && !/播放|暂停|play|pause/i.test(text);
  });
}

function hasPlayableSource(media) {
  return Boolean(media?.currentSrc || media?.src || media?.readyState > 0);
}

function scorePlaybackMedia(media) {
  const rect = media.getBoundingClientRect();
  const visible = isVisibleElement(media);
  const isVideo = String(media.tagName || '').toLowerCase() === 'video';
  const area = visible ? rect.width * rect.height : 0;
  const rightSidePreviewBias = visible && rect.left > window.innerWidth * 0.3 ? 250000 : 0;
  const playingBias = !media.paused && !media.ended ? 10000000 : 0;
  const typeBias = isVideo ? 1000000 : 0;
  return playingBias + typeBias + rightSidePreviewBias + area;
}

function findBestPlaybackMedia() {
  const media = Array.from(document.querySelectorAll('video, audio'))
    .filter((item) => hasPlayableSource(item) && (isVisibleElement(item) || (!item.paused && !item.ended)));
  media.sort((a, b) => scorePlaybackMedia(b) - scorePlaybackMedia(a));
  return media[0] || null;
}

function togglePlaybackMedia(media) {
  if (!media) return false;
  try {
    if (!media.paused && !media.ended) {
      media.pause();
      return true;
    }
    const result = media.play();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        console.warn('[VevDemoBridge] media play rejected; falling back to editor control:', err);
        clickPlaybackControlFallback();
      });
    }
    return true;
  } catch (err) {
    console.warn('[VevDemoBridge] media playback toggle failed:', err);
    return false;
  }
}

function getPlaybackControlText(control) {
  return [
    getElementText(control),
    control.getAttribute?.('aria-label') || '',
    control.getAttribute?.('title') || '',
    control.getAttribute?.('data-testid') || '',
    control.className || '',
  ].join(' ').toLowerCase();
}

function scorePlaybackControl(control) {
  const text = getPlaybackControlText(control);
  if (!/(播放|暂停|play|pause|play_arrow)/i.test(text)) return -1;
  const rect = control.getBoundingClientRect();
  let score = 0;
  if (/(暂停|pause)/i.test(text)) score += 120;
  if (/(播放|play|play_arrow)/i.test(text)) score += 100;
  if (/(preview|player|control|play)/i.test(text)) score += 30;
  if (rect.left > window.innerWidth * 0.3) score += 80;
  if (rect.top > window.innerHeight * 0.2 && rect.top < window.innerHeight * 0.75) score += 60;
  if (rect.left < window.innerWidth * 0.25) score -= 60;
  return score;
}

function clickPlaybackControlFallback() {
  const controls = Array.from(document.querySelectorAll([
    'button',
    '[role="button"]',
    '[title]',
    '[aria-label]',
    '[class*="play"]',
    '[class*="Play"]',
    '[class*="pause"]',
    '[class*="Pause"]',
  ].join(','))).filter(isVisibleElement);
  const scored = controls
    .map((control) => ({ control, score: scorePlaybackControl(control) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  const target = scored[0]?.control || null;
  if (!target) {
    console.warn('[VevDemoBridge] no playback control matched (media元素和播放按钮都没找到，预览可能是canvas渲染+按钮无可辨文本)');
    return false;
  }
  console.log('[VevDemoBridge] playback fallback click:', {
    cls: String(target.className || '').slice(0, 60),
    title: target.getAttribute?.('title') || target.getAttribute?.('aria-label') || '',
  });
  target.click();
  return true;
}

// ── 快捷键诊断浮层（排查时改 true：把按键判定链画在页面右下角，截图即可诊断）──
// 2026-06-10 用它定位空格键问题：SDK 预览是 canvas 渲染（页面 0 个 media 元素），
// DOM 路线必然失败；真实接口是 editor.play()/pause()/seek(秒)，已接线，浮层关闭。
const SHORTCUT_DEBUG_OVERLAY = false;
let shortcutDebugOverlayEl = null;
let shortcutTrace = ['[诊断浮层就绪] 等待第一次按空格…'];

function renderShortcutDebugOverlay() {
  if (!SHORTCUT_DEBUG_OVERLAY) return;
  try {
    if (!shortcutDebugOverlayEl || !shortcutDebugOverlayEl.isConnected) {
      shortcutDebugOverlayEl = document.createElement('div');
      shortcutDebugOverlayEl.id = 'origin-vev-shortcut-debug';
      shortcutDebugOverlayEl.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:rgba(0,0,0,.85);color:#7fff9e;font:11px/1.6 monospace;padding:8px 10px;border-radius:6px;max-width:440px;white-space:pre-wrap;pointer-events:none;';
      (document.body || document.documentElement).appendChild(shortcutDebugOverlayEl);
    }
    shortcutDebugOverlayEl.textContent = shortcutTrace.join('\n');
  } catch (_) { /* 诊断本身绝不影响主流程 */ }
}

function traceShortcut(line, render) {
  if (!SHORTCUT_DEBUG_OVERLAY) return;
  shortcutTrace.push(line);
  if (shortcutTrace.length > 26) shortcutTrace = shortcutTrace.slice(-26);
  if (render) renderShortcutDebugOverlay();
}

function describeBlockingDialogs() {
  return Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"]'))
    .filter((el) => isVisibleElement(el))
    .map((el) => ({ cls: String(el.className || '').slice(0, 44), text: getElementText(el).slice(0, 20) }))
    .filter((item) => item.text && !/播放|暂停|play|pause/i.test(item.text))
    .slice(0, 3);
}

// SDK 预览是 canvas 渲染（页面无 video 元素），播放必须走 SDK 自己的接口。
// 探测 veveditorInstance / .editor 上疑似播放控制的属性名（沿原型链），供定位真实 API。
function collectOwnAndProtoNames(obj, depth = 3) {
  const names = new Set();
  let cur = obj;
  for (let i = 0; i < depth && cur && cur !== Object.prototype; i += 1) {
    try { Object.getOwnPropertyNames(cur).forEach((n) => names.add(n)); } catch (_) { break; }
    cur = Object.getPrototypeOf(cur);
  }
  return Array.from(names);
}

function probeEditorPlaybackApi() {
  const lines = [];
  const scan = (obj, label) => {
    if (!obj) { lines.push(`${label}: (空)`); return; }
    const all = collectOwnAndProtoNames(obj);
    const strong = all.filter((n) => /play|pause|stop|resume/i.test(n));
    const weak = all.filter((n) => /toggle|seek|timeline|player|preview/i.test(n) && !strong.includes(n));
    lines.push(`${label} 强相关: ${strong.slice(0, 18).join(', ') || '(无)'}`);
    if (weak.length) lines.push(`${label} 弱相关: ${weak.slice(0, 14).join(', ')}`);
  };
  scan(veveditorInstance, 'instance');
  scan(veveditorInstance?.editor, 'editor');
  const player = veveditorInstance?.editor?.player || veveditorInstance?.player;
  if (player) scan(player, 'player');
  return lines;
}

function probePreviewButtons() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return Array.from(document.querySelectorAll('button, [role="button"], svg, [class*="icon" i]'))
    .filter(isVisibleElement)
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left > w * 0.42 && r.top > h * 0.3 && r.top < h * 0.8 && r.width < 80 && r.height < 80;
    })
    .slice(0, 8)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return `<${el.tagName.toLowerCase()}> cls=${String(el.className?.baseVal ?? el.className ?? '').slice(0, 40)} @${Math.round(r.left)},${Math.round(r.top)}`;
    });
}

// ── 播放/暂停走 SDK editor.play()/editor.pause()（2026-06-10 运行时探测实锤）──
// editor 不暴露播放状态：用"currentTime 是否在走"轮询推导，空格按推导状态调用。
let editorLikelyPlaying = false;
let lastEditorTimeSample = null;

function installEditorPlaybackStatePoller() {
  if (window.__originVevPlaybackStatePollerInstalled) return;
  window.__originVevPlaybackStatePollerInstalled = true;
  window.setInterval(() => {
    const t = getVevEditorCurrentTime();
    if (t != null && lastEditorTimeSample != null) {
      editorLikelyPlaying = Math.abs(t - lastEditorTimeSample) > 0.005;
    } else if (t == null) {
      editorLikelyPlaying = false;
    }
    lastEditorTimeSample = t;
  }, 300);
}

function tryEditorPlayPause() {
  const editor = veveditorInstance?.editor;
  if (!editor) return '';
  try {
    if (editorLikelyPlaying && typeof editor.pause === 'function') {
      editor.pause();
      editorLikelyPlaying = false; // 乐观更新，300ms 轮询会校正
      return 'editor.pause';
    }
    if (!editorLikelyPlaying && typeof editor.play === 'function') {
      editor.play();
      editorLikelyPlaying = true;
      return 'editor.play';
    }
  } catch (err) {
    console.warn('[VevDemoBridge] editor play/pause failed:', err);
  }
  return '';
}

function performPlaybackToggle(source) {
  stopShuttle(); // 空格终止 J 键穿梭
  // 第一优先：SDK 编辑器自己的播放接口（预览是 canvas，页面无 media 元素）。
  const editorMethod = tryEditorPlayPause();
  if (editorMethod) {
    traceShortcut(`切换执行: ${editorMethod}() 调用成功 (推导状态=${editorLikelyPlaying ? '播放中' : '已暂停'})`, true);
    postToOrigin('vevdemo:status', {
      status: 'playback-shortcut-toggle',
      source: source || 'keyboard',
      usedMediaElement: false,
      method: editorMethod,
      currentTime: getVevEditorCurrentTime(),
      ...getBridgeState(),
    });
    return true;
  }
  // 兜底：media 元素 / 按钮匹配（editor 实例还没建出来时）。
  const media = findBestPlaybackMedia();
  const mediaToggled = togglePlaybackMedia(media);
  const handled = mediaToggled || clickPlaybackControlFallback();
  console.log('[VevDemoBridge] playback toggle:', {
    source: source || 'keyboard',
    mediaFound: Boolean(media),
    mediaToggled,
    handled,
    mediaCount: document.querySelectorAll('video, audio').length,
  });
  traceShortcut(
    `切换执行: media找到=${media ? '是(' + media.tagName.toLowerCase() + ')' : '否'} ` +
    `media切换=${mediaToggled ? '成功' : '否'} 兜底按钮=${!media || !mediaToggled ? (handled ? '点击了' : '没找到') : '未用'} ` +
    `页面media数=${document.querySelectorAll('video, audio').length}`,
    true,
  );
  if (!handled) {
    // 走到这说明 DOM 路线全军覆没（canvas 渲染）：自动探测 SDK 真实接口，浮层展示供截图。
    traceShortcut('—— SDK接口自动探测(请把这屏截图发我) ——', false);
    try {
      probeEditorPlaybackApi().forEach((line) => traceShortcut(line, false));
      const buttons = probePreviewButtons();
      traceShortcut('预览区候选按钮: ' + (buttons.length ? '' : '(无)'), false);
      buttons.forEach((line) => traceShortcut('  ' + line, false));
    } catch (probeErr) {
      traceShortcut('探测时报错: ' + (probeErr?.message || String(probeErr)), false);
    }
    renderShortcutDebugOverlay();
    console.log('[VevDemoBridge] playback api probe:', probeEditorPlaybackApi(), probePreviewButtons());
    return false;
  }
  postToOrigin('vevdemo:status', {
    status: 'playback-shortcut-toggle',
    source: source || 'keyboard',
    usedMediaElement: Boolean(media),
    currentTime: getVevEditorCurrentTime(),
    ...getBridgeState(),
  });
  return true;
}

function tryEditorSeek(targetSec) {
  const editor = veveditorInstance?.editor;
  if (!editor) return false;
  const attempts = [
    () => { if (typeof editor.seek !== 'function') return false; editor.seek(targetSec); return true; },
    () => { if (typeof editor.setCurrentTime !== 'function') return false; editor.setCurrentTime(targetSec); return true; },
    () => { editor.currentTime = targetSec; return true; },
  ];
  for (const attempt of attempts) {
    try {
      if (!attempt()) continue;
      // 写后读回验证：避免对只读属性赋值"假装成功"。
      const after = Number(editor.currentTime);
      if (Number.isFinite(after) && Math.abs(after - targetSec) < 0.35) return true;
    } catch (_) { /* 尝试下一种写法 */ }
  }
  return false;
}

function performEditorSeek(options = {}) {
  const media = findBestPlaybackMedia();
  const editorTime = getVevEditorCurrentTime();
  const mediaTime = Number(media?.currentTime);
  const currentSec = editorTime != null
    ? editorTime
    : (Number.isFinite(mediaTime) ? mediaTime : null);
  const editorDuration = getVevEditorDuration();
  const mediaDuration = Number(media?.duration);
  const durationSec = editorDuration != null
    ? editorDuration
    : (Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : null);

  let target = null;
  if (options.toStart) target = 0;
  else if (options.toEnd) target = durationSec;
  else if (Number.isFinite(options.toAbsolute)) target = Number(options.toAbsolute);
  else if (currentSec != null) target = currentSec + (Number(options.deltaSec) || 0);
  if (target == null) return false;
  target = Math.max(0, durationSec != null ? Math.min(target, durationSec) : target);

  let method = '';
  if (tryEditorSeek(target)) {
    method = 'editor';
  } else if (media) {
    try {
      media.currentTime = target;
      method = 'media';
    } catch (_) { /* 媒体元素也写不进就放弃 */ }
  }
  traceShortcut(`seek执行: 目标=${Math.round(target * 10) / 10}s 方式=${method || '全部失败(editor.seek签名可能不是秒,截图发我)'}`, true);
  if (!method) return false;
  lastEditorTimeSample = null; // seek 造成的时间跳变不算"在播放"，跳过一个采样周期
  postToOrigin('vevdemo:status', {
    status: 'seek-shortcut',
    method,
    targetTime: target,
    ...getBridgeState(),
  });
  return true;
}

function performCutShortcut() {
  const button = getCutToolbarButton();
  if (!button) return false;
  if (isCutToolbarButtonActive(button)) {
    // 已有选中片段：直接触发剪切。
    button.click();
    return true;
  }
  if (cutAutoSelectRetrying) return true;
  const target = findTrackSelectionTargetAtCurrentTime();
  if (!target || !selectVevTrackElement(target.element)) {
    postToOrigin('vevdemo:status', {
      status: 'cut-disabled',
      reason: 'no_track_item_at_current_time',
      source: 'keyboard',
      currentTime: getVevEditorCurrentTime(),
      ...getBridgeState(),
    });
    return false;
  }
  cutAutoSelectRetrying = true;
  postToOrigin('vevdemo:status', {
    status: 'cut-auto-select',
    source: 'keyboard',
    currentTime: getVevEditorCurrentTime(),
    itemId: target.item?.ID || target.element?.id || null,
    ...getBridgeState(),
  });
  window.setTimeout(() => retryCutToolbarClick(), 40);
  return true;
}

// ── J/K/L 穿梭控制：SDK 无倒放/变速接口，J=连续快退模拟（250ms 后跳 0.5s）──
let shuttleTimer = null;

function stopShuttle() {
  if (!shuttleTimer) return false;
  window.clearInterval(shuttleTimer);
  shuttleTimer = null;
  return true;
}

function startShuttleBack() {
  stopShuttle();
  try { veveditorInstance?.editor?.pause?.(); } catch (_) { /* 没有实例时静默 */ }
  editorLikelyPlaying = false;
  shuttleTimer = window.setInterval(() => {
    const cur = getVevEditorCurrentTime();
    if (cur == null || cur <= 0.05) {
      stopShuttle();
      return;
    }
    performEditorSeek({ deltaSec: -0.5 });
  }, 250);
  return true;
}

function performEditorPause() {
  stopShuttle();
  const editor = veveditorInstance?.editor;
  if (editor && typeof editor.pause === 'function') {
    try {
      editor.pause();
      editorLikelyPlaying = false;
      return true;
    } catch (err) { console.warn('[VevDemoBridge] editor.pause failed:', err); }
  }
  return false;
}

function performEditorPlay() {
  stopShuttle();
  const editor = veveditorInstance?.editor;
  if (editor && typeof editor.play === 'function') {
    try {
      editor.play();
      editorLikelyPlaying = true;
      return true;
    } catch (err) { console.warn('[VevDemoBridge] editor.play failed:', err); }
  }
  return false;
}

// ── I/O：跳到播放头所在片段的开头/结尾（SDK 无进出点接口，用跳转语义替代）──
function getTrackTimeUnitFactor(items) {
  const duration = getVevEditorDuration();
  const maxEnd = items.reduce((max, item) => {
    const end = Number(item?.TargetTime?.[1]);
    return Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0);
  if (!duration || !maxEnd) return 1;
  if (maxEnd > duration * 100000) return 1000000;
  if (maxEnd > duration * 50) return 1000;
  return 1;
}

function performJumpToClipEdge(edge) {
  const item = findTrackItemAtCurrentTime();
  if (!item || !Array.isArray(item.TargetTime)) return false;
  const track = getVevEditorProjectData()?.LatestEditParam?.Track;
  const factor = getTrackTimeUnitFactor(flattenVevTrackItems(track));
  const startSec = Number(item.TargetTime[0]) / factor;
  const endSec = Number(item.TargetTime[1]) / factor;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return false;
  // 跳结尾留 0.04s 余量，避免播放头落进下一个片段。
  const target = edge === 'start' ? startSec : Math.max(startSec, endSec - 0.04);
  return performEditorSeek({ toAbsolute: target });
}

// ── +/-：时间线缩放。优先驱动时间线区域的 range 滑杆（React 受控组件需原生 setter），
//        找不到滑杆再按 title/aria/class 匹配缩放按钮，全失败则放行按键。──
function performTimelineZoom(direction) {
  const h = window.innerHeight;
  const slider = Array.from(document.querySelectorAll('input[type="range"]')).find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top > h * 0.45 && rect.width > 0;
  });
  if (slider) {
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || 100;
    const before = Number(slider.value) || 0;
    const next = Math.min(max, Math.max(min, before + ((max - min) / 10) * direction));
    if (Math.abs(next - before) > 1e-9) {
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(slider, String(next)); else slider.value = String(next);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (err) {
        console.warn('[VevDemoBridge] timeline zoom via slider failed:', err);
        return false;
      }
    }
    return true; // 到达边界也算已处理，避免按键漏给页面滚动
  }
  const button = Array.from(document.querySelectorAll('button, [role="button"], [class*="zoom" i]'))
    .filter(isVisibleElement)
    .find((el) => {
      const text = `${el.getAttribute?.('title') || ''} ${el.getAttribute?.('aria-label') || ''} ${String(el.className?.baseVal ?? el.className ?? '')}`;
      return direction > 0 ? /zoom.?in|放大/i.test(text) : /zoom.?out|缩小/i.test(text);
    });
  if (button) {
    button.click();
    return true;
  }
  return false;
}

// 统一快捷键分发：本地键盘和 Origin 父页转发(origin:editorShortcut)共用同一入口。
function dispatchEditorShortcut(desc) {
  if (hasVisibleBlockingDialog()) {
    const blockers = describeBlockingDialogs();
    console.warn('[VevDemoBridge] shortcut blocked by visible dialog:', blockers);
    traceShortcut('被"可见弹窗"拦截(若你没看到弹窗=误判): ' + JSON.stringify(blockers), true);
    return false;
  }
  const shiftKey = Boolean(desc?.shiftKey);
  switch (String(desc?.code || '')) {
    case 'Space':
      return performPlaybackToggle(desc?.source || 'keyboard');
    case 'ArrowLeft':
      return performEditorSeek({ deltaSec: shiftKey ? -5 : -0.1 });
    case 'ArrowRight':
      return performEditorSeek({ deltaSec: shiftKey ? 5 : 0.1 });
    case 'Home':
      return performEditorSeek({ toStart: true });
    case 'End':
      return performEditorSeek({ toEnd: true });
    case 'KeyC':
      return performCutShortcut();
    case 'KeyI':
      return performJumpToClipEdge('start');
    case 'KeyO':
      return performJumpToClipEdge('end');
    case 'KeyJ':
      return startShuttleBack();
    case 'KeyK':
      return performEditorPause();
    case 'KeyL':
      return performEditorPlay();
    case 'Equal':
    case 'NumpadAdd':
      return performTimelineZoom(1);
    case 'Minus':
    case 'NumpadSubtract':
      return performTimelineZoom(-1);
    default:
      return false;
  }
}

function handlePlaybackShortcut(event) {
  if (!(event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar')) return;
  // 诊断日志：空格链路各判定点（量小，仅按空格时打印）。
  const editable = isEditableShortcutTarget(event.target);
  console.log('[VevDemoBridge] Space keydown received:', {
    defaultPrevented: event.defaultPrevented,
    repeat: event.repeat,
    hasModifier: Boolean(event.metaKey || event.ctrlKey || event.altKey),
    editableTarget: editable,
    targetTag: String(event.target?.tagName || event.target?.constructor?.name || ''),
  });
  shortcutTrace = [];
  traceShortcut(`[空格 ${new Date().toLocaleTimeString()}] keydown已收到`, false);
  if (event.defaultPrevented || event.repeat) {
    traceShortcut(`提前退出: defaultPrevented=${event.defaultPrevented} repeat=${event.repeat}(SDK或浏览器先处理了)`, true);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    traceShortcut('提前退出: 按了修饰键(Cmd/Ctrl/Opt)', true);
    return;
  }
  if (editable) {
    traceShortcut('提前退出: 焦点在输入框里(点一下空白处再按)', true);
    return;
  }
  if (!dispatchEditorShortcut({ code: 'Space', source: 'keyboard' })) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

const EDITOR_BUBBLE_SHORTCUT_CODES = new Set([
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'KeyC',
  'KeyI', 'KeyO', 'KeyJ', 'KeyK', 'KeyL',
  'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
]);

// 新增按键走冒泡阶段：SDK 组件若自己消费(stopPropagation/preventDefault)会自动让位，
// 不抢 SDK 已有的方向键/按键行为；空格保持原 capture 行为不变。
function handleEditorBubbleShortcut(event) {
  if (event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!EDITOR_BUBBLE_SHORTCUT_CODES.has(event.code)) return;
  if (event.repeat && event.code === 'KeyC') return;
  if (isEditableShortcutTarget(event.target)) return;
  if (!dispatchEditorShortcut({ code: event.code, shiftKey: event.shiftKey, source: 'keyboard' })) return;
  event.preventDefault();
}

function installPlaybackKeyboardShortcuts() {
  if (window.__originVevPlaybackKeyboardShortcutsInstalled) return;
  if (!document.body) {
    window.addEventListener('DOMContentLoaded', installPlaybackKeyboardShortcuts, { once: true });
    return;
  }
  window.__originVevPlaybackKeyboardShortcutsInstalled = true;
  // Space 挂 window capture（比 document capture 更早），防 SDK 在 window 层抢先吃掉。
  window.addEventListener('keydown', handlePlaybackShortcut, true);
  document.addEventListener('keydown', handleEditorBubbleShortcut, false);
  console.log('[VevDemoBridge] editor shortcuts installed (space/arrows/home/end/cut/io/jkl/zoom), build 2026-06-11-2');
  if (SHORTCUT_DEBUG_OVERLAY) {
    // 浮层一出现就证明新代码已加载进 iframe（没出现 = 还在跑旧代码/没刷新/vite没起）。
    shortcutTrace = ['[诊断 build 2026-06-10-6] 浮层开启', '按快捷键查看判定链'];
    renderShortcutDebugOverlay();
  }
}

const playbackMediaHealth = new WeakMap();

function schedulePlaybackSoftRetry(media, reason) {
  const state = playbackMediaHealth.get(media);
  if (!state || media.paused || media.ended) return;
  if (state.retryCount >= 3) return;
  if (state.retryTimer) window.clearTimeout(state.retryTimer);
  const retryIndex = state.retryCount++;
  const delay = [500, 1400, 2600][retryIndex] || 2600;
  state.retryTimer = window.setTimeout(() => {
    state.retryTimer = null;
    if (media.paused || media.ended) return;
    const beforeTime = Number(media.currentTime) || 0;
    try {
      const result = media.play();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.warn('[VevDemoBridge] media soft retry failed:', { reason, error: err?.message || String(err || '') });
        });
      }
    } catch (err) {
      console.warn('[VevDemoBridge] media soft retry threw:', { reason, error: err?.message || String(err || '') });
    }
    window.setTimeout(() => {
      const moved = Math.abs((Number(media.currentTime) || 0) - beforeTime) > 0.03;
      if (!media.paused && !media.ended && !moved && media.readyState < 3) {
        schedulePlaybackSoftRetry(media, `${reason}:still-waiting`);
      }
    }, 900);
  }, delay);
}

function bindPlaybackMediaHealth(media) {
  if (!media || playbackMediaHealth.has(media)) return;
  playbackMediaHealth.set(media, { retryTimer: null, retryCount: 0 });
  if (String(media.tagName || '').toLowerCase() === 'video') {
    media.playsInline = true;
  }
  const reset = () => {
    const state = playbackMediaHealth.get(media);
    if (!state) return;
    state.retryCount = 0;
    if (state.retryTimer) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  };
  const softRetry = (event) => schedulePlaybackSoftRetry(media, event.type);
  media.addEventListener('playing', reset);
  media.addEventListener('timeupdate', reset);
  media.addEventListener('pause', reset);
  media.addEventListener('ended', reset);
  media.addEventListener('waiting', softRetry);
  media.addEventListener('stalled', softRetry);
  media.addEventListener('suspend', () => {
    if (!media.paused && media.readyState < 3) schedulePlaybackSoftRetry(media, 'suspend');
  });
  media.addEventListener('error', () => {
    postToOrigin('vevdemo:status', {
      status: 'playback-media-error',
      errorCode: media.error?.code || null,
      currentSrc: media.currentSrc || media.src || '',
      ...getBridgeState(),
    });
  });
}

function scanPlaybackMedia(root = document.body) {
  if (!root) return;
  const media = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches?.('video, audio')) media.push(root);
  if (root.querySelectorAll) media.push(...root.querySelectorAll('video, audio'));
  media.forEach(bindPlaybackMediaHealth);
}

function installPlaybackHealthMonitor() {
  if (window.__originVevPlaybackHealthMonitorInstalled) return;
  if (!document.body) {
    window.addEventListener('DOMContentLoaded', installPlaybackHealthMonitor, { once: true });
    return;
  }
  window.__originVevPlaybackHealthMonitorInstalled = true;
  scanPlaybackMedia(document.body);
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes?.forEach((node) => scanPlaybackMedia(node));
    });
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function normalizeOriginVideoForSearch(item) {
  const originId = String(item?.id || item?.task_id || item?.taskId || '').trim();
  const binding = item?.vevBinding || {};
  const realVid = binding.vid || extractVidFromVevSource(binding.vevSource);
  // The SDK's system-import modal may create edit materials directly from a real Vid.
  // Keep the searchable Vid synthetic so confirmation always calls getVideoInfo,
  // where Origin can register/reuse the project-scoped material idempotently.
  const vid = originId ? originVideoSyntheticVid(originId) : realVid;
  const title = readOriginMaterialTitle(item) || `项目视频 ${Number.isFinite(Number(item?.groupIdx)) ? Number(item.groupIdx) + 1 : originId}`;
  const duration = toIntegerDurationSeconds(item?.durationSec ?? item?.duration_sec);
  const playUrl = toOriginAbsoluteUrl(item?.url || item?.result_url || '');
  const coverUrl = findOriginCoverUrl(item);
  const createTime = item?.createdAt || item?.created_at || '';
  const updatedTime = item?.updatedAt || item?.updated_at || createTime;
  const fileInfo = {
    FileID: vid,
    FileHash: '',
    Height: 0,
    Width: 0,
    Duration: duration,
    Size: 0,
    Format: 'MP4',
    Codec: '',
    EncodedType: '',
    Definition: 'unknown',
    Bitrate: 0,
    LogoType: '',
    FileExt: {
      Fps: '',
      VQuality: '',
      PktOffset: '',
      TTCopyright: '',
    },
  };

  return {
    Vid: vid,
    Id: vid,
    Title: title,
    Duration: duration,
    DurationText: formatMinuteSecond(duration),
    PosterUrl: coverUrl,
    PosterURL: coverUrl,
    posterUrl: coverUrl,
    posterURL: coverUrl,
    CoverUrl: coverUrl,
    CoverURL: coverUrl,
    coverUrl,
    coverURL: coverUrl,
    ThumbnailUrl: coverUrl,
    thumbnailUrl: coverUrl,
    SnapshotUrl: coverUrl,
    snapshotUrl: coverUrl,
    CreateTime: createTime,
    BasicInfo: {
      PosterUri: '',
      Title: title,
      Duration: duration,
      DurationText: formatMinuteSecond(duration),
      PosterUrl: coverUrl,
      PosterURL: coverUrl,
      posterUrl: coverUrl,
      posterURL: coverUrl,
      CoverUrl: coverUrl,
      CoverURL: coverUrl,
      coverUrl,
      coverURL: coverUrl,
      ThumbnailUrl: coverUrl,
      thumbnailUrl: coverUrl,
      SnapshotUrl: coverUrl,
      snapshotUrl: coverUrl,
      UserReference: '',
      CreatedTime: createTime,
      CreateTime: createTime,
      UpdatedTime: updatedTime,
      PublishStatus: 'Published',
      TranscodeStatus: 'Encoded',
      Tags: '',
      Description: '',
      Category: 'video',
      AuditStatus: 0,
      AuditDesc: '',
      Format: 'MP4',
      Classification: null,
      TosStorageClass: 'STANDARD',
      VodUploadSource: 'origin',
      BlockStatus: '',
    },
    FileInfos: [fileInfo],
    VideoExt: {
      FileType: 'video',
      BigThumbs: '',
      CoverUrl: coverUrl,
      CoverURL: coverUrl,
      PosterUrl: coverUrl,
      PosterURL: coverUrl,
    },
    PlayInfo: {
      MainPlayUrl: playUrl,
      PlayUrl: playUrl,
      BackupPlayUrl: playUrl ? [playUrl] : [],
    },
    SourceInfo: {
      Source: '',
      EditMid: '',
      Space: '',
    },
    OriginProjectScoped: true,
    OriginVideoTaskId: originId,
    OriginResourceType: 'video_task',
    OriginNeedsRegistration: !binding.vevEditMid,
    OriginRowBelongsToCurrentEdl: Boolean(item?.rowBelongsToCurrentEdl),
    OriginRegisteredVid: realVid,
    OriginRegisteredVevEditMid: binding.vevEditMid || '',
    OriginRegisteredVevSource: binding.vevSource || '',
  };
}

function readPositivePagingNumber(values, fallback) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
  }
  return fallback;
}

function readNonNegativePagingOffset(values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

function normalizeOriginProjectVideoSearchResult(payload, params = {}) {
  const rawList = payload?.videos || payload?.items || payload?.tasks || [];
  const keyword = readSearchKeyword(params);
  // 排序在分页切片之前做，保证翻页边界也按片段编号连续。
  const all = sortMaterialListBySegmentOrder(
    (Array.isArray(rawList) ? rawList : [])
      .filter((item) => matchesOriginVideoSearch(item, keyword))
      .map(normalizeOriginVideoForSearch),
  );
  const pageSize = readPositivePagingNumber([params.PageSize, params.pageSize, params.Limit, params.limit], all.length || 20);
  const pageNum = readPositivePagingNumber([params.PageNum, params.pageNum, params.PageNo, params.pageNo], 1);
  const offset = readNonNegativePagingOffset([params.Offset, params.offset, params.StartOffset, params.startOffset]);
  // 火山 SDK 的分页控件传 Offset + Limit，而不是 PageNum + PageSize。
  // 没有 Offset 时保留 PageNum 兼容，避免影响外部调用方。
  const start = offset !== null ? offset : (pageNum - 1) * pageSize;
  const page = all.slice(start, start + pageSize);
  return {
    Total: all.length,
    Count: page.length,
    VideoSet: {
      Total: all.length,
      VideoInfos: page,
    },
    VideoInfos: page,
    MediaInfoList: page,
    Detail: page,
    OriginProjectScoped: true,
    OriginProjectId: activeOriginProjectId || '',
  };
}

function readOriginMaterialTitle(item) {
  return String(
    item?.downloadFilename ||
    item?.download_filename ||
    item?.filename ||
    item?.title ||
    item?.name ||
    item?.displayName ||
    item?.display_name ||
    '',
  ).trim();
}

function resetOriginMaterialTitleCache(projectId = activeOriginProjectId) {
  originMaterialTitleCache.projectId = String(projectId || '').trim();
  originMaterialTitleCache.expiresAt = 0;
  originMaterialTitleCache.promise = null;
  originMaterialTitleCache.byTaskId = new Map();
  originMaterialTitleCache.bySource = new Map();
  originMaterialTitleCache.byEditMid = new Map();
  originMaterialTitleCache.byVid = new Map();
  originMaterialTitleCache.latestSubtitleTitle = '';
  reapplyPersistentOriginMaterialTitles();
}

function persistentMaterialTitleKey(item) {
  if (!item || typeof item !== 'object') return '';
  const projectId = String(item.originProjectId || item.OriginProjectId || activeOriginProjectId || '').trim();
  const editMid = String(item.vevEditMid || item.VevEditMid || item.EditMid || item.editMid || item.MaterialId || item.materialId || '').trim();
  const source = String(item.vevSource || item.VevSource || item.source || item.Source || '').trim();
  const id = String(item.id || item.resourceId || item.filename || item.name || item.title || '').trim();
  const key = editMid || source || id;
  return projectId && key ? `${projectId}:${key}` : '';
}

function rememberPersistentOriginMaterialTitle(item) {
  const key = persistentMaterialTitleKey(item);
  if (!key) return;
  const projectId = String(item.originProjectId || item.OriginProjectId || activeOriginProjectId || '').trim();
  persistentOriginMaterialTitleItems.set(key, { ...item, originProjectId: projectId });
}

function reapplyPersistentOriginMaterialTitles() {
  const projectId = String(originMaterialTitleCache.projectId || activeOriginProjectId || '').trim();
  if (!projectId) return;
  persistentOriginMaterialTitleItems.forEach((item) => {
    const itemProjectId = String(item.originProjectId || item.OriginProjectId || '').trim();
    if (itemProjectId && itemProjectId !== projectId) return;
    rememberOriginMaterialTitle(item);
  });
}

function rememberOriginMaterialTitle(item, options = {}) {
  if (!item || typeof item !== 'object') return;
  const title = readOriginMaterialTitle(item);
  if (!title) return;
  if (options.persist) rememberPersistentOriginMaterialTitle(item);
  const type = String(item.type || item.Type || item.MaterialType || '').trim().toLowerCase();
  if (type === 'subtitle' || /\.(srt|vtt|ass)$/i.test(title)) {
    originMaterialTitleCache.latestSubtitleTitle = title;
  }
  const binding = item.vevBinding || {};
  const taskIds = [
    item.id,
    item.task_id,
    item.taskId,
    item.resourceId,
    item.OriginVideoTaskId,
    item.originVideoTaskId,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  taskIds.forEach((taskId) => originMaterialTitleCache.byTaskId.set(taskId, title));

  const sources = [
    item.vevSource,
    item.VevSource,
    item.source,
    item.Source,
    binding.vevSource,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  sources.forEach((source) => {
    originMaterialTitleCache.bySource.set(source, title);
    const vid = extractVidFromVevSource(source);
    if (vid) originMaterialTitleCache.byVid.set(vid, title);
  });

  const editMids = [
    item.vevEditMid,
    item.VevEditMid,
    item.EditMid,
    item.editMid,
    item.MaterialId,
    item.materialId,
    binding.vevEditMid,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  editMids.forEach((editMid) => originMaterialTitleCache.byEditMid.set(editMid, title));

  const vids = [
    item.vid,
    item.Vid,
    binding.vid,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  vids.forEach((vid) => originMaterialTitleCache.byVid.set(vid, title));
}

async function refreshOriginMaterialTitleCache(force = false) {
  const projectId = String(activeOriginProjectId || '').trim();
  if (!projectId) return originMaterialTitleCache;
  const now = Date.now();
  if (
    !force &&
    originMaterialTitleCache.projectId === projectId &&
    originMaterialTitleCache.expiresAt > now
  ) {
    return originMaterialTitleCache;
  }
  if (originMaterialTitleCache.promise) return originMaterialTitleCache.promise;

  originMaterialTitleCache.promise = requestOrigin('searchProjectVideos', {
    projectId,
    params: { PageSize: 500, pageSize: 500, scope: 'all-completed' },
  }, 15000)
    .then((payload) => {
      resetOriginMaterialTitleCache(projectId);
      const rawList = payload?.videos || payload?.items || payload?.tasks || [];
      (Array.isArray(rawList) ? rawList : []).forEach(rememberOriginMaterialTitle);
      originMaterialTitleCache.expiresAt = Date.now() + 8000;
      originMaterialTitleCache.promise = null;
      scheduleOriginMaterialNamePolish();
      return originMaterialTitleCache;
    })
    .catch((err) => {
      originMaterialTitleCache.promise = null;
      console.warn('[VevDemoBridge] refresh Origin material titles failed:', err?.message || err);
      return originMaterialTitleCache;
    });
  return originMaterialTitleCache.promise;
}

function titleForEditMaterial(item) {
  if (!item || typeof item !== 'object') return '';
  const editMid = String(item.EditMid || item.editMid || item.MaterialId || item.materialId || item.Id || item.id || '').trim();
  if (editMid && originMaterialTitleCache.byEditMid.has(editMid)) return originMaterialTitleCache.byEditMid.get(editMid);
  const source = readEditMaterialSource(item) || String(item.VevSource || '').trim();
  if (source && originMaterialTitleCache.bySource.has(source)) return originMaterialTitleCache.bySource.get(source);
  const vid = extractVidFromVevSource(source) || String(item.Vid || item.vid || item.FileId || item.FileID || '').trim();
  if (vid && originMaterialTitleCache.byVid.has(vid)) return originMaterialTitleCache.byVid.get(vid);
  const taskId = String(item.OriginVideoTaskId || item.originVideoTaskId || item.ResourceId || item.resourceId || '').trim();
  if (taskId && originMaterialTitleCache.byTaskId.has(taskId)) return originMaterialTitleCache.byTaskId.get(taskId);
  return '';
}

function renameEditMaterialItem(item, title) {
  if (!item || !title) return item;
  const next = {
    ...item,
    Name: title,
    Title: title,
    name: title,
    title,
    DisplayName: title,
    displayName: title,
  };
  ['BasicInfo', 'VideoInfo', 'MaterialInfo', 'SourceInfo'].forEach((key) => {
    if (item[key] && typeof item[key] === 'object' && !Array.isArray(item[key])) {
      next[key] = {
        ...item[key],
        Name: title,
        Title: title,
        DisplayName: title,
        displayName: title,
      };
    }
  });
  return next;
}

function editMaterialLooksLikeSubtitle(item, title = '') {
  const type = readMaterialType(item);
  const name = String(title || readMaterialName(item) || '').trim();
  return type === 'subtitle' || /\.(srt|vtt|ass)$/i.test(name);
}

function enhanceSubtitleEditMaterialItem(item, title = '') {
  if (!item || !editMaterialLooksLikeSubtitle(item, title)) return item;
  const name = String(title || readMaterialName(item) || item.Name || item.Title || item.id || 'Origin subtitles.srt').trim();
  const format = (/\.(vtt)$/i.test(name) && 'VTT') || (/\.(ass)$/i.test(name) && 'ASS') || 'SRT';
  const next = renameEditMaterialItem(item, name);
  Object.assign(next, {
    Type: 'subtitle',
    type: 'subtitle',
    MaterialType: 'subtitle',
    materialType: 'subtitle',
    Category: 'subtitle',
    category: 'subtitle',
    Format: format,
    format,
    FileType: 'object',
    fileType: 'object',
    DurationText: '字幕',
    OriginSubtitleMaterial: true,
  });
  next.BasicInfo = {
    ...(item.BasicInfo || {}),
    ...(next.BasicInfo || {}),
    Name: name,
    Title: name,
    DisplayName: name,
    Type: 'subtitle',
    MaterialType: 'subtitle',
    Category: 'subtitle',
    Format: format,
    FileType: 'object',
    DurationText: '字幕',
  };
  return next;
}

function applyOriginTitlesToEditMaterialResult(result) {
  if (!result || typeof result !== 'object') return result;
  let changed = false;
  const next = { ...result };
  EDIT_MATERIAL_LIST_KEYS.forEach((key) => {
    const list = Array.isArray(result[key]) ? result[key] : null;
    if (!list) return;
    next[key] = list.map((item) => {
      const title = titleForEditMaterial(item) || (editMaterialLooksLikeSubtitle(item) ? readMaterialName(item) : '');
      if (editMaterialLooksLikeSubtitle(item, title)) {
        changed = true;
        return enhanceSubtitleEditMaterialItem(item, title);
      }
      if (!title) return item;
      changed = true;
      return renameEditMaterialItem(item, title);
    });
  });
  if (result.MaterialSet && Array.isArray(result.MaterialSet.MaterialInfos)) {
    next.MaterialSet = {
      ...result.MaterialSet,
      MaterialInfos: result.MaterialSet.MaterialInfos.map((item) => {
        const title = titleForEditMaterial(item) || (editMaterialLooksLikeSubtitle(item) ? readMaterialName(item) : '');
        if (editMaterialLooksLikeSubtitle(item, title)) {
          changed = true;
          return enhanceSubtitleEditMaterialItem(item, title);
        }
        if (!title) return item;
        changed = true;
        return renameEditMaterialItem(item, title);
      }),
    };
  }
  if (changed) scheduleOriginMaterialNamePolish();
  return next;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceLegacyOriginMaterialText(value) {
  let next = String(value ?? '');
  if (!next) return next;
  const subtitleTitle = String(originMaterialTitleCache.latestSubtitleTitle || '').trim();
  if (subtitleTitle && /未知\s*Item|Unknown\s*Item/i.test(next)) {
    next = next
      .replace(/未知\s*Item/g, subtitleTitle)
      .replace(/Unknown\s*Item/gi, subtitleTitle);
  }
  if (originMaterialTitleCache.byTaskId.size <= 0) return next;
  originMaterialTitleCache.byTaskId.forEach((title, taskId) => {
    if (!taskId || !title || !next.includes(taskId)) return;
    const escaped = escapeRegExp(taskId);
    next = next
      .replace(new RegExp(`origin-${escaped}(?:\\.mp4)?`, 'g'), title)
      .replace(new RegExp(`${escaped}_片段[^\\n\\r]+?\\.mp4`, 'g'), title);
  });
  return next;
}

function shouldSkipOriginMaterialNamePolish(parent) {
  const tagName = String(parent?.tagName || '').toLowerCase();
  return ['script', 'style', 'noscript', 'textarea', 'input', 'select', 'option'].includes(tagName);
}

function polishOriginMaterialNames(root = document.body) {
  if (!root || (originMaterialTitleCache.byTaskId.size <= 0 && !originMaterialTitleCache.latestSubtitleTitle)) return;
  const elements = [];
  if (root.nodeType === Node.ELEMENT_NODE) elements.push(root);
  if (root.querySelectorAll) {
    root.querySelectorAll('[title], [aria-label]').forEach((element) => elements.push(element));
  }
  elements.forEach((element) => {
    ['title', 'aria-label'].forEach((attr) => {
      const raw = element.getAttribute?.(attr);
      if (!raw) return;
      const next = replaceLegacyOriginMaterialText(raw);
      if (next !== raw) element.setAttribute(attr, next);
    });
  });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (shouldSkipOriginMaterialNamePolish(node.parentElement)) return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue || '';
      return /origin-[0-9a-f-]{36}|[0-9a-f-]{36}_片段|origin-subtitles-[\w-]+-v\d+\.(?:srt|vtt|ass)|未知\s*Item|Unknown\s*Item/iu.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  let node = walker.nextNode();
  while (node && nodes.length < 500) {
    nodes.push(node);
    node = walker.nextNode();
  }
  nodes.forEach((textNode) => {
    const raw = textNode.nodeValue || '';
    const next = replaceLegacyOriginMaterialText(raw);
    if (next !== raw) textNode.nodeValue = next;
  });
}

function injectOriginSubtitleMaterialCardStyle() {
  if (document.getElementById('origin-vevdemo-subtitle-material-card-style')) return;
  const style = document.createElement('style');
  style.id = 'origin-vevdemo-subtitle-material-card-style';
  style.textContent = `
    .${SUBTITLE_MATERIAL_CARD_CLASS} {
      position: relative !important;
      min-height: 156px !important;
      padding-top: 108px !important;
      box-sizing: border-box !important;
    }

    .${SUBTITLE_MATERIAL_CARD_CLASS} .${SUBTITLE_MATERIAL_THUMB_CLASS} {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      height: 96px !important;
      border-radius: 4px !important;
      border: 1px solid rgba(46, 230, 214, 0.32) !important;
      background:
        linear-gradient(135deg, rgba(31, 44, 52, 0.98), rgba(14, 21, 25, 0.98)),
        repeating-linear-gradient(0deg, rgba(255,255,255,0.08) 0 1px, transparent 1px 12px) !important;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04) !important;
      color: rgba(255,255,255,0.92) !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 4px !important;
      pointer-events: none !important;
      overflow: hidden !important;
    }

    .${SUBTITLE_MATERIAL_CARD_CLASS} .${SUBTITLE_MATERIAL_THUMB_CLASS}::before,
    .${SUBTITLE_MATERIAL_CARD_CLASS} .${SUBTITLE_MATERIAL_THUMB_CLASS}::after {
      content: "" !important;
      width: 68% !important;
      height: 6px !important;
      border-radius: 999px !important;
      background: rgba(255,255,255,0.18) !important;
      display: block !important;
    }

    .${SUBTITLE_MATERIAL_CARD_CLASS} .origin-subtitle-file-badge {
      font-size: 18px !important;
      line-height: 1 !important;
      font-weight: 800 !important;
      letter-spacing: 0 !important;
      color: #2ee6d6 !important;
    }

    .${SUBTITLE_MATERIAL_CARD_CLASS} .origin-subtitle-file-meta {
      font-size: 11px !important;
      line-height: 1.2 !important;
      letter-spacing: 0 !important;
      color: rgba(255,255,255,0.72) !important;
    }
  `;
  document.head.appendChild(style);
}

function findSubtitleMaterialCard(labelElement) {
  let node = labelElement;
  for (let i = 0; i < 7 && node && node !== document.body; i += 1) {
    if (!(node instanceof Element)) {
      node = node?.parentElement || null;
      continue;
    }
    const text = getElementText(node);
    const rect = node.getBoundingClientRect?.();
    const hasMedia = Boolean(node.querySelector?.('img, video, canvas'));
    const plausibleRect = rect
      && rect.width >= 72
      && rect.width <= 280
      && rect.height >= 60
      && rect.height <= 260;
    if (SUBTITLE_MATERIAL_LABEL_RE.test(text) && plausibleRect && !hasMedia) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function ensureSubtitleMaterialCard(card) {
  if (!card || !(card instanceof Element)) return;
  if (!SUBTITLE_MATERIAL_LABEL_RE.test(getElementText(card))) return;
  card.classList.add(SUBTITLE_MATERIAL_CARD_CLASS);
  if (card.querySelector?.(`.${SUBTITLE_MATERIAL_THUMB_CLASS}`)) return;
  const thumb = document.createElement('div');
  thumb.className = SUBTITLE_MATERIAL_THUMB_CLASS;
  thumb.setAttribute('aria-hidden', 'true');
  thumb.innerHTML = '<span class="origin-subtitle-file-badge">CC</span><span class="origin-subtitle-file-meta">字幕文件 · SRT</span>';
  card.insertBefore(thumb, card.firstChild);
}

function polishOriginSubtitleMaterialCards(root = document.body) {
  if (!root) return;
  injectOriginSubtitleMaterialCardStyle();
  const labels = [];
  if (root.nodeType === Node.TEXT_NODE && SUBTITLE_MATERIAL_LABEL_RE.test(root.nodeValue || '')) {
    labels.push(root.parentElement);
  }
  const walkerRoot = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
  if (walkerRoot) {
    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (shouldSkipOriginMaterialNamePolish(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return SUBTITLE_MATERIAL_LABEL_RE.test(node.nodeValue || '')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let node = walker.nextNode();
    while (node && labels.length < 100) {
      labels.push(node.parentElement);
      node = walker.nextNode();
    }
  }
  labels.filter(Boolean).forEach((element) => ensureSubtitleMaterialCard(findSubtitleMaterialCard(element)));
}

function scheduleOriginMaterialNamePolish() {
  if (originMaterialNamePolishTimer) window.clearTimeout(originMaterialNamePolishTimer);
  originMaterialNamePolishTimer = window.setTimeout(() => {
    originMaterialNamePolishTimer = null;
    polishOriginMaterialNames(document.body);
    scheduleOriginSubtitleMaterialCardPolish();
  }, 60);
}

function scheduleOriginSubtitleMaterialCardPolish(delay = 80) {
  if (originSubtitleMaterialCardTimer) window.clearTimeout(originSubtitleMaterialCardTimer);
  originSubtitleMaterialCardTimer = window.setTimeout(() => {
    originSubtitleMaterialCardTimer = null;
    polishOriginSubtitleMaterialCards(document.body);
  }, delay);
}

function installOriginMaterialNamePolisher() {
  if (originMaterialNamePolisherInstalled) return;
  originMaterialNamePolisherInstalled = true;
  const observer = new MutationObserver((mutations) => {
    let shouldPolish = false;
    mutations.forEach((mutation) => {
      if (mutation.type === 'characterData') {
        shouldPolish = shouldPolish || /origin-[0-9a-f-]{36}|[0-9a-f-]{36}_片段|origin-subtitles-[\w-]+-v\d+\.(?:srt|vtt|ass)|未知\s*Item|Unknown\s*Item/iu.test(mutation.target?.nodeValue || '');
      }
      mutation.addedNodes?.forEach((node) => {
        if (shouldPolish) return;
        const text = node.textContent || '';
        shouldPolish = /origin-[0-9a-f-]{36}|[0-9a-f-]{36}_片段|origin-subtitles-[\w-]+-v\d+\.(?:srt|vtt|ass)|未知\s*Item|Unknown\s*Item/iu.test(text);
      });
    });
    if (shouldPolish) scheduleOriginMaterialNamePolish();
  });
  const start = () => {
    if (!document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    scheduleOriginMaterialNamePolish();
  };
  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
}

async function searchOriginProjectVideos(params = {}) {
  if (!activeOriginProjectId) {
    return normalizeOriginProjectVideoSearchResult({ videos: [] }, params);
  }
  const payload = await requestOrigin('searchProjectVideos', {
    projectId: activeOriginProjectId,
    params,
  });
  const result = normalizeOriginProjectVideoSearchResult(payload, params);
  const rawList = payload?.videos || payload?.items || payload?.tasks || [];
  (Array.isArray(rawList) ? rawList : []).forEach(rememberOriginMaterialTitle);
  scheduleOriginMaterialNamePolish();
  return result;
}

function emptyEditMaterialSearchResult() {
  return { Total: 0, Detail: [] };
}

const EDIT_MATERIAL_LIST_KEYS = ['Detail', 'EditMaterialList', 'MaterialList', 'MaterialInfoList'];

// 素材库/系统导入列表统一按片段编号自然排序：
// 片段1 → 片段1（1）→ 片段1（2）→ 片段2 → … → 片段10。
// （默认顺序按导入时间/字符串排，片段10 会插到片段2 前面，这里按数字解析。）
// 非"片段N"命名（本地上传、旧 origin-xxx 命名等）排在所有片段之后，保持原有相对顺序。
const SEGMENT_NAME_ORDER_RE = /^片段(\d+)(?:（(\d+)）|\((\d+)\))?/u;

function readMaterialDisplayNameForOrder(item) {
  if (!item || typeof item !== 'object') return '';
  const basic = item.BasicInfo && typeof item.BasicInfo === 'object' ? item.BasicInfo : {};
  return String(
    item.Name || item.Title || item.name || item.title || basic.Name || basic.Title || '',
  ).trim();
}

function segmentOrderKeyForMaterial(item) {
  const match = SEGMENT_NAME_ORDER_RE.exec(readMaterialDisplayNameForOrder(item));
  if (!match) return null;
  return {
    seg: Number(match[1]),
    copy: Number(match[2] || match[3] || 0),
  };
}

function sortMaterialListBySegmentOrder(list) {
  if (!Array.isArray(list) || list.length <= 1) return list;
  return list
    .map((item, index) => ({ item, index, key: segmentOrderKeyForMaterial(item) }))
    .sort((a, b) => {
      if (a.key && b.key) {
        return (a.key.seg - b.key.seg) || (a.key.copy - b.key.copy) || (a.index - b.index);
      }
      if (a.key) return -1;
      if (b.key) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

function sortEditMaterialResultBySegmentOrder(result) {
  if (!result || typeof result !== 'object') return result;
  const next = { ...result };
  EDIT_MATERIAL_LIST_KEYS.forEach((key) => {
    if (Array.isArray(next[key])) next[key] = sortMaterialListBySegmentOrder(next[key]);
  });
  return next;
}

function dedupeMaterialListBySource(list) {
  if (!Array.isArray(list) || list.length <= 1) return { list, changed: false };
  const seen = new Set();
  const next = [];
  let changed = false;
  for (const item of list) {
    const source = readEditMaterialSource(item);
    if (!source) {
      next.push(item);
      continue;
    }
    if (seen.has(source)) {
      changed = true;
      continue;
    }
    seen.add(source);
    next.push(item);
  }
  return { list: next, changed };
}

function dedupeEditMaterialResultBySource(result) {
  if (!result || typeof result !== 'object') return { result, changed: false };
  const next = { ...result };
  let primaryListLength = null;
  let changed = false;

  EDIT_MATERIAL_LIST_KEYS.forEach((key) => {
    if (!Array.isArray(result[key])) return;
    const deduped = dedupeMaterialListBySource(result[key]);
    next[key] = deduped.list;
    if (primaryListLength === null) primaryListLength = deduped.list.length;
    if (deduped.changed) changed = true;
  });

  if (result.MaterialSet && Array.isArray(result.MaterialSet.MaterialInfos)) {
    const deduped = dedupeMaterialListBySource(result.MaterialSet.MaterialInfos);
    next.MaterialSet = { ...result.MaterialSet, MaterialInfos: deduped.list };
    if (primaryListLength === null) primaryListLength = deduped.list.length;
    if (deduped.changed) changed = true;
  }

  if (primaryListLength !== null && Number(next.Total) !== primaryListLength) {
    next.Total = primaryListLength;
  }
  if (primaryListLength !== null && Number(next.Count) !== primaryListLength) {
    next.Count = primaryListLength;
  }
  return { result: next, changed };
}

function filterEditMaterialSearchResultByProject(result, projectId) {
  const expectedProjectId = String(projectId || '').trim();
  const next = { ...(result || {}) };
  let primaryListLength = null;
  let changed = false;

  EDIT_MATERIAL_LIST_KEYS.forEach((key) => {
    const list = Array.isArray(result?.[key]) ? result[key] : null;
    if (!list) return;
    const filtered = list.filter((item) => {
      const itemProjectId = String(item?.ProjectId || '').trim();
      return !itemProjectId || itemProjectId === expectedProjectId;
    });
    next[key] = filtered;
    if (primaryListLength === null) primaryListLength = filtered.length;
    if (filtered.length !== list.length) changed = true;
  });

  if (primaryListLength !== null && Number(next.Total) !== primaryListLength) {
    next.Total = primaryListLength;
  }
  if (primaryListLength !== null && Number(next.Count) !== primaryListLength) {
    next.Count = primaryListLength;
  }
  return { result: next, changed };
}

function emptyMaterialDetailResult() {
  return {
    Total: 0,
    Detail: [],
    MaterialInfoList: [],
    MaterialSet: { MaterialInfos: [] },
  };
}

async function searchOriginScopedEditMaterial(params = {}) {
  if (!isProjectIsolationReady()) {
    console.warn('[VevDemoBridge] blocked SearchEditMaterial before project isolation is ready:', params);
    postToOrigin('vevdemo:status', {
      status: 'material-search-blocked',
      reason: 'project-isolation-not-ready',
      ...getBridgeState(),
    });
    return emptyEditMaterialSearchResult();
  }
  const scopedParams = {
    ...params,
    ProjectId: activeVevProjectId,
    Space: params.Space || 'origin',
  };
  const result = await searchEditMaterial(scopedParams);
  const scopedResult = filterEditMaterialSearchResultByProject(result, activeVevProjectId);
  if (scopedResult.changed) {
    console.warn('[VevDemoBridge] filtered cross-project edit materials:', {
      requestedProjectId: activeVevProjectId,
    });
  }
  const dedupedResult = dedupeEditMaterialResultBySource(scopedResult.result);
  if (dedupedResult.changed) {
    console.warn('[VevDemoBridge] deduped repeated edit materials by Source:', {
      requestedProjectId: activeVevProjectId,
    });
  }
  await refreshOriginMaterialTitleCache();
  // 标题先就位再排序（排序键取自展示名"片段N（M）_…"）。
  return sortEditMaterialResultBySegmentOrder(applyOriginTitlesToEditMaterialResult(dedupedResult.result));
}

async function mGetOriginScopedMaterial(params = {}) {
  if (!isProjectIsolationReady()) {
    console.warn('[VevDemoBridge] blocked MGetMaterial before project isolation is ready:', params);
    postToOrigin('vevdemo:status', {
      status: 'material-detail-blocked',
      reason: 'project-isolation-not-ready',
      ...getBridgeState(),
    });
    return emptyMaterialDetailResult();
  }
  return mGetMaterial(params);
}

function normalizeRegisteredOriginVideoInfo(material, fallback = {}) {
  const source = String(material?.vevSource || material?.source || '').trim();
  const realVid = extractVidFromVevSource(source);
  const playUrl = material?.url || fallback?.url || '';
  const duration = toIntegerDurationSeconds(material?.durationSec ?? fallback?.Duration ?? fallback?.duration);
  return {
    Vid: realVid || fallback?.Vid || fallback?.vid || '',
    Title: material?.title || fallback?.Title || fallback?.title || material?.id || '',
    Duration: duration,
    DurationText: formatMinuteSecond(duration),
    PosterUrl: material?.coverUrl || fallback?.PosterUrl || '',
    CoverURL: material?.coverUrl || fallback?.CoverURL || '',
    PlayUrl: playUrl,
    MainPlayUrl: playUrl,
    OriginProjectScoped: true,
    OriginVideoTaskId: material?.id || fallback?.originVideoTaskId || '',
    VevEditMid: material?.vevEditMid || '',
    VevSource: source,
  };
}

async function getOriginAwareVideoInfo(params = {}) {
  const originVideoTaskId = readOriginVideoTaskId(params);
  if (!originVideoTaskId) return getVideoPlayInfo(params);

  const payload = await requestOrigin('registerProjectVideo', {
    projectId: activeOriginProjectId,
    videoTaskId: originVideoTaskId,
  }, 15 * 60 * 1000);
  const materials = Array.isArray(payload?.materials) ? payload.materials : [];
  const material = materials.find((item) => String(item?.id || '') === originVideoTaskId) || materials[0] || null;
  if (!material) throw new Error(`Origin project video was not registered: ${originVideoTaskId}`);
  return normalizeRegisteredOriginVideoInfo(material, params);
}

function normalizeTimelineTimeUnit(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['ms', 'millisecond', 'milliseconds'].includes(text)) return 'ms';
  if (['us', 'microsecond', 'microseconds'].includes(text)) return 'us';
  return '';
}

function toTimelineTime(sec, timeUnit) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 0;
  const multiplier = timeUnit === 'us' ? 1000000 : 1000;
  return Math.round(Math.max(0, n) * multiplier);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeEditParamFromProject(projectInfo) {
  const raw = readFirst({ projectInfo }, [
    'projectInfo.EditParam',
    'projectInfo.LatestEditParam',
    'projectInfo.Project.EditParam',
    'projectInfo.Project.LatestEditParam',
    'projectInfo.Detail.EditParam',
    'projectInfo.Detail.LatestEditParam',
  ]);
  const parsed = parseMaybeJson(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function collectTimelineTimingSignals(track) {
  const values = [];
  const ranges = [];
  const visit = (value, key = '') => {
    if (values.length >= 48 || value == null) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      values.push({ key, value });
      return;
    }
    if (Array.isArray(value)) {
      if (/time|duration/i.test(key) && value.length >= 2) {
        const start = Number(value[0]);
        const end = Number(value[1]);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          ranges.push({ key, value: Math.abs(end - start), start, end });
        }
      }
      value.forEach((item, index) => visit(item, `${key}[${index}]`));
      return;
    }
    if (typeof value !== 'object') return;
    Object.keys(value).forEach((childKey) => {
      if (!/time|duration/i.test(childKey)) return;
      visit(value[childKey], key ? `${key}.${childKey}` : childKey);
    });
  };
  visit(track, 'Track');
  return { values, ranges };
}

function summarizeTimelineTiming(track) {
  const signals = collectTimelineTimingSignals(track);
  const values = signals.values.slice(0, 24);
  const ranges = signals.ranges.slice(0, 24);
  const positives = values
    .concat(ranges)
    .map((item) => Number(item.value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    hasTrack: Array.isArray(track),
    sample: values,
    ranges,
    minPositiveValue: positives.length ? Math.min(...positives) : 0,
    maxValue: positives.reduce((max, value) => Math.max(max, value), 0),
  };
}

function collectPlanTimingSeconds(plan) {
  const seconds = [];
  const add = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0.05) seconds.push(n);
  };
  add(plan?.totalDurationSec);
  (Array.isArray(plan?.video) ? plan.video : []).forEach((item) => {
    add(item?.durationSec);
    add(item?.outSec);
    add(item?.targetEndSec);
    add(item?.transitionIn?.durationSec || item?.transitionIn?.duration);
    add(item?.transitionOut?.durationSec || item?.transitionOut?.duration);
  });
  (Array.isArray(plan?.subtitles) ? plan.subtitles : []).forEach((item) => {
    add(item?.startSec);
    add(item?.endSec);
  });
  add(plan?.bgm?.offsetSec);
  return seconds;
}

function scoreTimelineUnitAgainstPlan(observedValues, planSeconds, multiplier) {
  if (!planSeconds.length) return 0;
  return observedValues.reduce((score, observed) => {
    const matched = planSeconds.some((seconds) => {
      const expected = seconds * multiplier;
      const tolerance = Math.max(multiplier === 1000000 ? 20000 : 20, expected * 0.08);
      return Math.abs(observed - expected) <= tolerance;
    });
    return score + (matched ? 1 : 0);
  }, 0);
}

function hasNonOriginTimedTrackItem(track) {
  let found = false;
  const visit = (value) => {
    if (found || value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const type = String(value.Type || value.type || '').toLowerCase();
    const hasTiming = Array.isArray(value.TargetTime || value.targetTime)
      || Array.isArray(value.SourceTime || value.sourceTime);
    const hasSource = Boolean(value.Source || value.source);
    const hasOriginMarker = Boolean(value.OriginResourceId || value.originResourceId || value.OriginGroupIdx != null || value.originGroupIdx != null);
    if (hasTiming && hasSource && (type === 'video' || type === 'audio' || !type) && !hasOriginMarker) {
      found = true;
      return;
    }
    Object.keys(value).forEach((key) => visit(value[key]));
  };
  visit(track);
  return found;
}

function inferTimelineTimeUnitFromTrack(editParam, plan) {
  const summary = summarizeTimelineTiming(editParam?.Track);
  if (!summary.hasTrack || (!summary.sample.length && !summary.ranges.length)) {
    return { unit: '', reason: 'no_track_sample', summary };
  }

  const source = String(editParam?.OriginTimelineTimeUnitSource || editParam?.OriginAppliedTimeline?.timeUnitSource || '').trim();
  const isOriginWrittenTrack = Boolean(editParam?.OriginAppliedTimeline?.bridgeVersion === ORIGIN_BRIDGE_VERSION);
  if (isOriginWrittenTrack && source !== 'manual-track-inferred') {
    const hasManualSample = source === 'manual-selected' && hasNonOriginTimedTrackItem(editParam?.Track);
    if (!hasManualSample) {
      return { unit: '', reason: 'origin_written_track_not_trusted', summary };
    }
  }

  const observedValues = summary.ranges
    .map((item) => Number(item.value))
    .concat(summary.sample.map((item) => Number(item.value)))
    .filter((value) => Number.isFinite(value) && value >= 50);
  if (!observedValues.length) return { unit: '', reason: 'no_significant_timing_value', summary };

  const planSeconds = collectPlanTimingSeconds(plan);
  const msScore = scoreTimelineUnitAgainstPlan(observedValues, planSeconds, 1000);
  const usScore = scoreTimelineUnitAgainstPlan(observedValues, planSeconds, 1000000);
  if (msScore > usScore && msScore > 0) return { unit: 'ms', reason: 'track_matches_plan_ms', summary, msScore, usScore };
  if (usScore > msScore && usScore > 0) return { unit: 'us', reason: 'track_matches_plan_us', summary, msScore, usScore };
  if (planSeconds.length && msScore === 0 && usScore === 0) {
    return { unit: '', reason: 'track_timing_does_not_match_plan', summary, msScore, usScore };
  }
  if (planSeconds.length && msScore === usScore) {
    return { unit: '', reason: 'ambiguous_track_timing_scores', summary, msScore, usScore };
  }

  const significant = observedValues.filter((value) => value >= 100);
  const min = significant.length ? Math.min(...significant) : 0;
  const max = significant.length ? Math.max(...significant) : 0;
  if (min >= 100000 && max >= 100000) return { unit: 'us', reason: 'track_value_magnitude_us', summary, msScore, usScore };
  if (min >= 100 && min <= 60000 && max <= 600000) return { unit: 'ms', reason: 'track_value_magnitude_ms', summary, msScore, usScore };
  return { unit: '', reason: 'ambiguous_track_timing', summary, msScore, usScore };
}

function readLocalTimelineTimeUnit() {
  let storedUnit = '';
  try {
    storedUnit = window.localStorage?.getItem('origin:vevdemo:timelineTimeUnit') || '';
  } catch (_) {}
  return normalizeTimelineTimeUnit(storedUnit);
}

function clearLocalTimelineTimeUnit(reason, staleUnit, inferredUnit) {
  try {
    if (!window.localStorage?.getItem('origin:vevdemo:timelineTimeUnit')) return;
    window.localStorage.removeItem('origin:vevdemo:timelineTimeUnit');
    console.info('[VevDemoBridge] cleared stale timeline time unit localStorage:', {
      reason,
      staleUnit,
      inferredUnit,
    });
  } catch (err) {
    console.warn('[VevDemoBridge] failed to clear stale timeline time unit localStorage:', {
      reason,
      staleUnit,
      inferredUnit,
      error: err?.message || String(err || ''),
    });
  }
}

function createTimelineApplyError(code, reason, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.reason = reason;
  err.details = details;
  return err;
}

function createTimelineTimeUnitError(reason, message, details = {}) {
  return createTimelineApplyError('timeline_time_unit', reason, message, details);
}

function isPlanMatchedTimelineInference(inferred) {
  return ['track_matches_plan_ms', 'track_matches_plan_us'].includes(String(inferred?.reason || ''));
}

function resolveTimelineTimeUnit(editParam, plan) {
  const localUnit = readLocalTimelineTimeUnit();
  const projectUnit = normalizeTimelineTimeUnit(editParam?.OriginTimelineTimeUnit || editParam?.OriginAppliedTimeline?.timeUnit);
  const projectSource = String(editParam?.OriginTimelineTimeUnitSource || editParam?.OriginAppliedTimeline?.timeUnitSource || '').trim();
  const inferred = inferTimelineTimeUnitFromTrack(editParam, plan);
  if (!inferred.unit && ['track_timing_does_not_match_plan', 'ambiguous_track_timing_scores', 'ambiguous_track_timing'].includes(inferred.reason)) {
    console.warn('[VevDemoBridge] timeline time unit cannot be inferred from Track sample:', inferred);
    throw createTimelineTimeUnitError(
      inferred.reason,
      `VevDemo timeline time unit is ambiguous: ${inferred.reason}. Clear or correct origin:vevdemo:timelineTimeUnit, then drag a fresh short sample clip before applying timeline.`,
      { inferred, localUnit, projectUnit, projectSource }
    );
  }
  if (inferred.unit) {
    const decision = { unit: inferred.unit, source: 'manual-track-inferred', inferred };
    if (localUnit && localUnit !== inferred.unit) {
      if (!isPlanMatchedTimelineInference(inferred)) {
        console.warn('[VevDemoBridge] timeline time unit localStorage conflicts with magnitude-only Track inference; selected unit wins:', { localUnit, inferred });
        return {
          unit: localUnit,
          source: 'manual-selected',
          inferred,
          ignoredTrackUnit: inferred.unit,
          ignoredTrackUnitReason: inferred.reason || '',
        };
      }
      console.warn('[VevDemoBridge] timeline time unit localStorage is stale; track inference wins:', { localUnit, inferred });
      clearLocalTimelineTimeUnit('track-inference-conflict', localUnit, inferred.unit);
      decision.ignoredLocalUnit = localUnit;
    }
    if (projectUnit && projectSource === 'manual-track-inferred' && projectUnit !== inferred.unit) {
      console.warn('[VevDemoBridge] timeline time unit project metadata is stale; track inference wins:', { projectUnit, projectSource, inferred });
      decision.previousProjectUnit = projectUnit;
      decision.previousProjectUnitSource = projectSource;
    }
    return decision;
  }

  if (projectUnit && projectSource === 'manual-track-inferred') {
    return { unit: projectUnit, source: 'manual-track-inferred', inferred };
  }

  if (localUnit) {
    // This is a selected unit, not proof that VevDemo accepted this unit. A later manual Track sample must still win.
    return { unit: localUnit, source: 'manual-selected', inferred };
  }

  console.warn('[VevDemoBridge] timeline time unit is unverified; automatic timeline update is blocked:', inferred);
  throw createTimelineTimeUnitError(
    inferred.reason || 'unverified',
    'VevDemo timeline time unit is unverified. Drag one clip manually so describeProject exposes EditParam.Track timing values, or set localStorage origin:vevdemo:timelineTimeUnit to "ms" or "us" as a temporary selected unit.',
    { inferred, localUnit, projectUnit, projectSource }
  );
}

function flattenEffectCandidates(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenEffectCandidates(item, out));
    return out;
  }
  if (typeof value !== 'object') return out;
  const id = readFirst({ value }, [
    'value.EffectId',
    'value.effectId',
    'value.ResourceId',
    'value.resourceId',
    'value.ResId',
    'value.resId',
    'value.Id',
    'value.id',
  ]);
  const name = readFirst({ value }, [
    'value.Name',
    'value.name',
    'value.Title',
    'value.title',
    'value.DisplayName',
    'value.displayName',
  ]);
  if (id && name) out.push({ id: String(id), name: String(name), raw: value });
  Object.keys(value).forEach((key) => {
    if (key === 'raw') return;
    const child = value[key];
    if (child && typeof child === 'object') flattenEffectCandidates(child, out);
  });
  return out;
}

function resolveTransitionEffectMap(effectResult) {
  const candidates = flattenEffectCandidates(effectResult);
  const find = (needles) => {
    const hit = candidates.find((item) => {
      const text = `${item.name} ${JSON.stringify(item.raw || {})}`.toLowerCase();
      return needles.some((needle) => text.includes(needle));
    });
    return hit?.id || '';
  };
  const map = {
    fade: find(['fade', '淡入', '淡出', '渐隐', '渐显']),
    dissolve: find(['dissolve', 'cross', '叠化', '溶解']),
    wipe: find(['wipe', '擦除', '划像']),
  };
  Object.defineProperty(map, '_candidateCount', { value: candidates.length, enumerable: false });
  return map;
}

function collectMissingTransitionTypes(plan, effectMap) {
  const missing = new Set();
  const videoItems = Array.isArray(plan?.video) ? plan.video : [];
  videoItems.forEach((item) => {
    const transition = item?.transitionIn || {};
    const type = String(transition.type || 'cut').toLowerCase();
    const duration = Number(transition.durationSec || transition.duration || 0);
    if (type && type !== 'cut' && duration > 0 && !effectMap[type]) missing.add(type);
  });
  return Array.from(missing);
}

function transitionExtraFor(item, effectMap, timeUnit) {
  const transition = item?.transitionIn || {};
  const type = String(transition.type || 'cut').toLowerCase();
  const duration = toTimelineTime(transition.durationSec || transition.duration || 0, timeUnit);
  const effectId = type === 'cut' ? '' : effectMap[type] || '';
  if (!effectId || duration <= 0) return [];
  return [{
    Type: 'transition',
    EffectId: effectId,
    TransitionType: type,
    Duration: duration,
  }];
}

function resolveCanvasSize(editParam) {
  const canvas = editParam && typeof editParam === 'object' ? editParam.Canvas : null;
  const width = Number(canvas?.Width);
  const height = Number(canvas?.Height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 720,
    height: Number.isFinite(height) && height > 0 ? height : 1280,
  };
}

// 画布尺寸跟随 Origin 项目画面比例（plan.canvas 由 online_editor.js 按一键成片同口径算好）。
// 仅在铺轨时同步：铺轨本身就是覆盖语义（且只在空轨道/用户手动确认时发生）。
function resolveTargetCanvasFromPlan(plan, editParam) {
  const width = Number(plan?.canvas?.width);
  const height = Number(plan?.canvas?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { changed: false };
  }
  const current = resolveCanvasSize(editParam);
  if (current.width === width && current.height === height) return { changed: false };
  return { changed: true, width, height, previous: current };
}

function countTrackItemsByType(track, type = '') {
  const wantType = String(type || '').trim().toLowerCase();
  let count = 0;
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const itemType = String(value.Type || value.type || '').trim().toLowerCase();
    const hasTiming = Array.isArray(value.TargetTime || value.targetTime)
      || Array.isArray(value.SourceTime || value.sourceTime);
    const hasSource = Boolean(value.Source || value.source || value.Text || value.text);
    if (itemType && hasTiming && hasSource && (!wantType || itemType === wantType)) {
      count += 1;
      return;
    }
    Object.keys(value).forEach((key) => visit(value[key]));
  };
  visit(track);
  return count;
}

function laneItemCount(track, type) {
  return countTrackItemsByType(track, type);
}


function buildTrackFromOriginPlan(plan, effectMap, timeUnit, editParam = null) {
  const videoTrack = [];
  const videoItems = Array.isArray(plan?.video) ? plan.video : [];
  const minDuration = toTimelineTime(0.1, timeUnit);
  for (const item of videoItems) {
    const source = String(item?.source || '').trim();
    if (!source) continue;
    const inTime = toTimelineTime(item.inSec, timeUnit);
    const outTime = Math.max(inTime + minDuration, toTimelineTime(item.outSec, timeUnit));
    const startTime = toTimelineTime(item.targetStartSec, timeUnit);
    const endTime = Math.max(startTime + minDuration, toTimelineTime(item.targetEndSec, timeUnit));
    videoTrack.push({
      Type: 'video',
      Source: source,
      TargetTime: [startTime, endTime],
      SourceTime: [inTime, outTime],
      Extra: transitionExtraFor(item, effectMap, timeUnit),
      OriginResourceId: item.resourceId || '',
      OriginGroupIdx: item.groupIdx,
    });
  }

  const track = [videoTrack];
  if (plan?.bgm?.source) {
    const startTime = toTimelineTime(plan.bgm.offsetSec, timeUnit);
    const endTime = Math.max(startTime + minDuration, toTimelineTime(plan.totalDurationSec, timeUnit));
    track.push([{
      Type: 'audio',
      Source: plan.bgm.source,
      TargetTime: [startTime, endTime],
      Extra: [{
        Type: 'volume',
        Volume: Number(plan.bgm.volume) || 0.32,
      }],
      OriginResourceId: plan.bgm.resourceId || '',
    }]);
  }
  return track;
}

function normalizeTimelineApplyPolicy(policy) {
  const mode = String(policy?.mode || '').trim();
  return {
    mode: mode || 'overwrite',
    silent: policy?.silent === true,
  };
}

function readTrackStateFromEditParam(editParam) {
  const hasLatestEditParam = Boolean(editParam && typeof editParam === 'object' && !Array.isArray(editParam));
  const track = hasLatestEditParam ? editParam.Track : undefined;
  const count = countTrackItemsByType(track);
  return {
    readable: hasLatestEditParam,
    empty: hasLatestEditParam && count === 0,
    count,
    track,
  };
}

function readRuntimeTrackState() {
  const projectData = getVevEditorProjectData();
  if (!projectData || typeof projectData !== 'object') {
    return { readable: false, empty: false, count: null, reason: 'projectData_unreadable' };
  }
  const editParam = projectData.LatestEditParam;
  if (!editParam || typeof editParam !== 'object' || Array.isArray(editParam)) {
    return { readable: false, empty: false, count: null, reason: 'latestEditParam_missing' };
  }
  const count = countTrackItemsByType(editParam.Track);
  return { readable: true, empty: count === 0, count, reason: count === 0 ? 'empty' : 'nonempty' };
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildTimelineSkipResult(reason, serverState, runtimeState, extra = {}) {
  return {
    ok: true,
    skipped: true,
    reason,
    serverTrackItemCount: Number(serverState?.count) || 0,
    runtimeTrackItemCount: runtimeState?.count == null ? null : Number(runtimeState.count) || 0,
    runtimeReadable: runtimeState?.readable === true,
    ...extra,
  };
}

async function waitForServerTrackToBecomeEmpty(maxMs) {
  const startedAt = Date.now();
  let lastProjectInfo = null;
  let lastEditParam = null;
  let lastServerState = null;
  while (Date.now() - startedAt < maxMs) {
    await delay(500);
    lastProjectInfo = await describeProject({ ProjectId: activeVevProjectId, GroupId: activeVevGroupId });
    lastEditParam = normalizeEditParamFromProject(lastProjectInfo);
    lastServerState = readTrackStateFromEditParam(lastEditParam);
    if (lastServerState.count === 0) {
      return { projectInfo: lastProjectInfo, editParam: lastEditParam, serverState: lastServerState, emptied: true };
    }
  }
  return { projectInfo: lastProjectInfo, editParam: lastEditParam, serverState: lastServerState, emptied: false };
}

async function resolveFillIfEmptyDecision(projectInfo, editParam, policy) {
  let nextProjectInfo = projectInfo;
  let nextEditParam = editParam;
  let serverState = readTrackStateFromEditParam(nextEditParam);
  let runtimeState = readRuntimeTrackState();
  if (policy.mode !== 'fill-if-empty') {
    return { shouldApply: true, projectInfo: nextProjectInfo, editParam: nextEditParam, serverState, runtimeState };
  }

  if (serverState.count > 0 && runtimeState.readable && runtimeState.count > 0) {
    return { shouldApply: false, result: buildTimelineSkipResult('track_not_empty', serverState, runtimeState), projectInfo: nextProjectInfo, editParam: nextEditParam, serverState, runtimeState };
  }

  if (serverState.count > 0 && runtimeState.readable && runtimeState.empty) {
    const waited = await waitForServerTrackToBecomeEmpty(5000);
    if (waited.projectInfo && waited.editParam && waited.serverState) {
      nextProjectInfo = waited.projectInfo;
      nextEditParam = waited.editParam;
      serverState = waited.serverState;
    }
    runtimeState = readRuntimeTrackState();
    if (serverState.count > 0) {
      return { shouldApply: false, result: buildTimelineSkipResult('track_not_empty_after_clear_wait', serverState, runtimeState, { waitedMs: 5000 }), projectInfo: nextProjectInfo, editParam: nextEditParam, serverState, runtimeState };
    }
    return { shouldApply: true, projectInfo: nextProjectInfo, editParam: nextEditParam, serverState, runtimeState };
  }

  if (serverState.count > 0) {
    return { shouldApply: false, result: buildTimelineSkipResult('track_not_empty_runtime_unreadable', serverState, runtimeState), projectInfo: nextProjectInfo, editParam: nextEditParam, serverState, runtimeState };
  }

  if (serverState.count === 0 && runtimeState.readable && runtimeState.count > 0) {
    return { shouldApply: false, result: buildTimelineSkipResult('runtime_track_not_empty', serverState, runtimeState), projectInfo: nextProjectInfo, editParam: nextEditParam, serverState, runtimeState };
  }

  return { shouldApply: true, projectInfo: nextProjectInfo, editParam: nextEditParam, serverState, runtimeState };
}

function resolveTimelineTimeUnitForApply(editParam, plan, policy, serverState) {
  try {
    return resolveTimelineTimeUnit(editParam, plan);
  } catch (err) {
    const reason = String(err?.reason || '').trim();
    if (policy.mode === 'fill-if-empty' && reason === 'no_track_sample' && Number(serverState?.count) === 0) {
      const inferred = err?.details?.inferred || { reason: 'no_track_sample' };
      console.info('[VevDemoBridge] bootstrapping timeline time unit for empty track:', inferred);
      return { unit: 'ms', source: 'origin-empty-bootstrap', inferred };
    }
    throw err;
  }
}

function classifyRuntimeDurationMismatch(runtimeDurationSec, expectedDurationSec) {
  const runtime = Number(runtimeDurationSec);
  const expected = Number(expectedDurationSec);
  if (!Number.isFinite(runtime) || !Number.isFinite(expected) || runtime <= 0 || expected <= 0) return '';
  const ratio = runtime / expected;
  const inverse = expected / runtime;
  const near = (value, target) => value > target * 0.8 && value < target * 1.2;
  if (near(ratio, 1000) || near(inverse, 1000)) return 'duration_ratio_1000x';
  if (near(ratio, 1000000) || near(inverse, 1000000)) return 'duration_ratio_1000000x';
  return '';
}

async function waitForReadableRuntimeDuration(maxMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const duration = getVevEditorDuration();
    if (duration != null) return duration;
    await delay(500);
  }
  return null;
}

async function handleOriginApplyTimeline(plan, policyInput = {}) {
  if (!activeVevProjectId || !activeVevGroupId) {
    throw createTimelineApplyError(
      'timeline_project_not_ready',
      'project_not_ready',
      'VevDemo project is not ready for timeline update',
      {
        hasProjectId: Boolean(activeVevProjectId),
        hasGroupId: Boolean(activeVevGroupId),
        activeOriginProjectId,
      }
    );
  }
  const policy = normalizeTimelineApplyPolicy(policyInput);
  if (!plan || !Array.isArray(plan.video) || plan.video.length === 0) {
    throw createTimelineApplyError(
      'timeline_plan_empty',
      'plan_empty',
      'Origin timeline plan is empty',
      {
        hasPlan: Boolean(plan),
        videoCount: Array.isArray(plan?.video) ? plan.video.length : 0,
        projectId: plan?.projectId || activeOriginProjectId || '',
      }
    );
  }

  let [projectInfo, effectResult] = await Promise.all([
    describeProject({ ProjectId: activeVevProjectId, GroupId: activeVevGroupId }),
    getEffectList({ ProjectId: activeVevProjectId, GroupId: activeVevGroupId }).catch((err) => {
      console.warn('[VevDemoBridge] getEffectList failed, transitions will degrade to cut:', err);
      return null;
    }),
  ]);
  const effectMap = resolveTransitionEffectMap(effectResult);
  const fillDecision = await resolveFillIfEmptyDecision(projectInfo, normalizeEditParamFromProject(projectInfo), policy);
  if (!fillDecision.shouldApply) {
    if (!policy.silent) {
      console.info('[VevDemoBridge] fill-if-empty skipped existing track:', fillDecision.result);
    } else {
      console.log('[VevDemoBridge] fill-if-empty skipped existing track silently:', fillDecision.result);
    }
    return fillDecision.result;
  }

  projectInfo = fillDecision.projectInfo;
  const editParam = fillDecision.editParam;
  const timeUnitDecision = resolveTimelineTimeUnitForApply(editParam, plan, policy, fillDecision.serverState);
  const timeUnit = timeUnitDecision.unit;
  const missingTransitionTypes = collectMissingTransitionTypes(plan, effectMap);
  console.info('[VevDemoBridge] transition effect map resolved:', {
    effectMap,
    candidateCount: effectMap._candidateCount || 0,
    missingTransitionTypes,
  });
  if (missingTransitionTypes.length) {
    console.warn('[VevDemoBridge] transition effects were not matched and will degrade to cut:', missingTransitionTypes);
  }
  // 画布跟随项目比例：先定画布再建轨，避免视频轨按旧画布落位。
  const targetCanvas = resolveTargetCanvasFromPlan(plan, editParam);
  const editParamForLayout = targetCanvas.changed
    ? { ...editParam, Canvas: { ...(editParam?.Canvas || {}), Width: targetCanvas.width, Height: targetCanvas.height } }
    : editParam;
  if (targetCanvas.changed) {
    console.info('[VevDemoBridge] canvas follows Origin project aspect ratio:', targetCanvas);
  }
  const track = buildTrackFromOriginPlan(plan, effectMap, timeUnit, editParamForLayout);
  if (!countTrackItemsByType(track, 'video')) {
    throw createTimelineApplyError(
      'timeline_track_empty',
      'track_empty',
      'No VevDemo video track items were generated',
      {
        projectId: plan?.projectId || activeOriginProjectId || '',
        videoCount: Array.isArray(plan?.video) ? plan.video.length : 0,
      }
    );
  }

  const nextEditParam = { ...editParamForLayout };
  delete nextEditParam.OriginTimelineTimeUnitVerified;
  Object.assign(nextEditParam, {
    Track: track,
    OriginTimelineTimeUnit: timeUnit,
    OriginTimelineTimeUnitSource: timeUnitDecision.source,
    OriginTimelineTimeUnitCheckedAt: new Date().toISOString(),
    OriginAppliedTimeline: {
      projectId: plan.projectId || activeOriginProjectId || '',
      edlVersion: Number(plan.edlVersion) || 0,
      appliedAt: new Date().toISOString(),
      bridgeVersion: ORIGIN_BRIDGE_VERSION,
      timeUnit,
      timeUnitSource: timeUnitDecision.source,
      timeUnitInference: {
        reason: timeUnitDecision.inferred?.reason || '',
        msScore: Number(timeUnitDecision.inferred?.msScore) || 0,
        usScore: Number(timeUnitDecision.inferred?.usScore) || 0,
        ignoredLocalUnit: timeUnitDecision.ignoredLocalUnit || '',
        previousProjectUnit: timeUnitDecision.previousProjectUnit || '',
        previousProjectUnitSource: timeUnitDecision.previousProjectUnitSource || '',
      },
    },
  });
  const editParamIsString = typeof readFirst({ projectInfo }, ['projectInfo.EditParam', 'projectInfo.LatestEditParam']) === 'string';
  const buildPayload = () => (editParamIsString ? JSON.stringify(nextEditParam) : nextEditParam);

  const previousPayload = editParamIsString ? readFirst({ projectInfo }, ['projectInfo.EditParam', 'projectInfo.LatestEditParam']) : editParam;
  const updateResult = await updateProject({
    ProjectId: activeVevProjectId,
    GroupId: activeVevGroupId,
    EditParam: buildPayload(),
  });
  const runtimeDuration = await waitForReadableRuntimeDuration(5000);
  const durationMismatch = classifyRuntimeDurationMismatch(runtimeDuration, plan.totalDurationSec);
  if (durationMismatch) {
    console.warn('[VevDemoBridge] runtime duration indicates timeline time unit mismatch; rolling back:', {
      runtimeDuration,
      expectedDuration: plan.totalDurationSec,
      durationMismatch,
    });
    await updateProject({
      ProjectId: activeVevProjectId,
      GroupId: activeVevGroupId,
      EditParam: previousPayload,
    });
    throw createTimelineApplyError(
      'timeline_time_unit',
      'runtime_duration_unit_mismatch',
      'VevDemo runtime duration does not match Origin timeline after update; update was rolled back.',
      { runtimeDuration, expectedDuration: plan.totalDurationSec, durationMismatch, timeUnitDecision }
    );
  }
  return {
    ok: true,
    timelineTimeUnit: timeUnit,
    timelineTimeUnitSource: timeUnitDecision.source,
    timelineTimeUnitInference: {
      reason: timeUnitDecision.inferred?.reason || '',
      msScore: Number(timeUnitDecision.inferred?.msScore) || 0,
      usScore: Number(timeUnitDecision.inferred?.usScore) || 0,
      ignoredLocalUnit: timeUnitDecision.ignoredLocalUnit || '',
      previousProjectUnit: timeUnitDecision.previousProjectUnit || '',
      previousProjectUnitSource: timeUnitDecision.previousProjectUnitSource || '',
    },
    videoCount: countTrackItemsByType(track, 'video'),
    audioCount: countTrackItemsByType(track, 'audio'),
    runtimeDurationVerified: runtimeDuration == null ? false : !durationMismatch,
    runtimeDurationSec: runtimeDuration,
    canvasFollowed: targetCanvas.changed ? { width: targetCanvas.width, height: targetCanvas.height } : null,
    transitionEffectMap: effectMap,
    missingTransitionTypes,
    updateResult,
  };
}

function createSubtitleImportError(code, reason, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.reason = reason;
  err.details = details;
  return err;
}

function editMaterialListFromSearchResult(result) {
  const list =
    result?.Detail ||
    result?.MaterialInfoList ||
    result?.EditMaterialList ||
    result?.MaterialList ||
    result?.MaterialSet?.MaterialInfos ||
    [];
  return Array.isArray(list) ? list : [];
}

function readMaterialName(item) {
  return String(readFirst({ item }, [
    'item.Name',
    'item.Title',
    'item.name',
    'item.title',
    'item.DisplayName',
    'item.displayName',
    'item.BasicInfo.Name',
    'item.BasicInfo.Title',
    'item.BasicInfo.DisplayName',
  ]) || '').trim();
}

function readMaterialType(item) {
  return String(readFirst({ item }, [
    'item.Type',
    'item.type',
    'item.BasicInfo.Type',
    'item.BasicInfo.MaterialType',
    'item.Category',
    'item.category',
  ]) || '').trim().toLowerCase();
}

function readMaterialEditMid(item) {
  return String(readFirst({ item }, [
    'item.EditMid',
    'item.editMid',
    'item.MaterialId',
    'item.materialId',
    'item.Id',
    'item.id',
  ]) || '').trim();
}

function materialLooksLikeSubtitle(item) {
  const type = readMaterialType(item);
  return !type || type === 'subtitle';
}

function rememberSubtitleMaterialTitle({ filename, originProjectId, vevSource, editMid, material }) {
  const title = String(filename || readMaterialName(material) || '').trim();
  if (!title) return;
  const source = String(vevSource || material?.Source || material?.source || material?.BasicInfo?.Source || '').trim();
  const mid = String(editMid || readMaterialEditMid(material) || '').trim();
  rememberOriginMaterialTitle({
    id: title,
    filename: title,
    title,
    name: title,
    type: 'subtitle',
    originProjectId: originProjectId || activeOriginProjectId,
    vevSource: source,
    source,
    vevEditMid: mid,
    EditMid: mid,
    MaterialId: mid,
  }, { persist: true });
  scheduleOriginMaterialNamePolish();
}

async function findSubtitleMaterialByName(projectId, vevSpace, filename) {
  const search = await searchEditMaterial({ ProjectId: projectId, Space: vevSpace });
  return editMaterialListFromSearchResult(search).find((item) => (
    readMaterialName(item) === filename && materialLooksLikeSubtitle(item)
  )) || null;
}

function extractSupportedSubtitleVevSource(uploadResult) {
  console.info('[VevDemoBridge] subtitle upload complete raw result:', uploadResult);
  const source = String(readFirst({ uploadResult }, [
    'uploadResult.Source',
    'uploadResult.source',
    'uploadResult.info.Source',
    'uploadResult.info.source',
    'uploadResult.info.uploadResult.Source',
    'uploadResult.info.uploadResult.source',
    'uploadResult.info.uploadResult.Data.Source',
    'uploadResult.info.uploadResult.Data.source',
    'uploadResult.info.uploadResult.data.Source',
    'uploadResult.info.uploadResult.data.source',
    'uploadResult.info.Result.Source',
    'uploadResult.info.result.Source',
    'uploadResult.info.Result.source',
    'uploadResult.info.result.source',
  ]) || '').trim();
  if (isSupportedVevSource(source)) return { vevSource: source, sourceKind: 'source' };

  const vid = String(readFirst({ uploadResult }, [
    'uploadResult.Vid',
    'uploadResult.vid',
    'uploadResult.info.Vid',
    'uploadResult.info.vid',
    'uploadResult.info.uploadResult.Vid',
    'uploadResult.info.uploadResult.vid',
    'uploadResult.info.uploadResult.Data.Vid',
    'uploadResult.info.uploadResult.Data.vid',
    'uploadResult.info.uploadResult.data.Vid',
    'uploadResult.info.uploadResult.data.vid',
    'uploadResult.info.Result.Vid',
    'uploadResult.info.result.Vid',
    'uploadResult.info.Result.vid',
    'uploadResult.info.result.vid',
  ]) || '').trim();
  if (vid) {
    const vevSource = isSupportedVevSource(vid) ? vid : `vid://${vid}`;
    return { vevSource, sourceKind: 'vid', vid };
  }

  const oid = String(readFirst({ uploadResult }, [
    'uploadResult.Oid',
    'uploadResult.oid',
    'uploadResult.ObjectKey',
    'uploadResult.objectKey',
    'uploadResult.info.Oid',
    'uploadResult.info.oid',
    'uploadResult.info.ObjectKey',
    'uploadResult.info.objectKey',
    'uploadResult.info.uploadResult.Oid',
    'uploadResult.info.uploadResult.oid',
    'uploadResult.info.uploadResult.ObjectKey',
    'uploadResult.info.uploadResult.objectKey',
    'uploadResult.info.uploadResult.Data.Oid',
    'uploadResult.info.uploadResult.Data.oid',
    'uploadResult.info.uploadResult.Data.ObjectKey',
    'uploadResult.info.uploadResult.Data.objectKey',
    'uploadResult.info.uploadResult.data.Oid',
    'uploadResult.info.uploadResult.data.oid',
    'uploadResult.info.uploadResult.data.ObjectKey',
    'uploadResult.info.uploadResult.data.objectKey',
    'uploadResult.info.Result.Oid',
    'uploadResult.info.result.Oid',
    'uploadResult.info.Result.ObjectKey',
    'uploadResult.info.result.ObjectKey',
  ]) || '').trim();
  const mid = String(readFirst({ uploadResult }, [
    'uploadResult.Mid',
    'uploadResult.mid',
    'uploadResult.info.Mid',
    'uploadResult.info.mid',
    'uploadResult.info.uploadResult.Mid',
    'uploadResult.info.uploadResult.mid',
    'uploadResult.info.uploadResult.Data.Mid',
    'uploadResult.info.uploadResult.Data.mid',
    'uploadResult.info.uploadResult.data.Mid',
    'uploadResult.info.uploadResult.data.mid',
    'uploadResult.info.Result.Mid',
    'uploadResult.info.result.Mid',
  ]) || '').trim();
  if (mid) {
    const vevSource = isSupportedVevSource(mid) ? mid : `mid://${mid}`;
    return { vevSource, sourceKind: 'mid', oid, mid };
  }
  return { vevSource: '', sourceKind: '', oid, mid };
}

function uploadSubtitleFile(file, vevSpace) {
  return new Promise((resolve, reject) => {
    uploadMaterial(file, vevSpace, undefined, {
      onComplete: (result) => resolve(result),
      onError: (result) => reject(createSubtitleImportError(
        'subtitle_upload_failed',
        'upload_failed',
        result?.error?.message || String(result?.error || 'subtitle upload failed'),
        { result }
      )),
      onProgress: (result) => {
        console.info('[VevDemoBridge] subtitle upload progress:', result?.info || result);
      },
    }).catch((err) => reject(createSubtitleImportError(
      'subtitle_upload_failed',
      'upload_setup_failed',
      err?.message || String(err || 'subtitle upload setup failed'),
      { error: err?.message || String(err || '') }
    )));
  });
}

async function readBackSubtitleMaterial({ projectId, vevSpace, filename, editMid, vevSource }) {
  if (editMid) {
    const byMid = await searchEditMaterial({ ProjectId: projectId, Space: vevSpace, EditMids: [editMid] });
    const hitByMid = editMaterialListFromSearchResult(byMid).find((item) => materialLooksLikeSubtitle(item));
    if (hitByMid) return hitByMid;
  }
  const search = await searchEditMaterial({ ProjectId: projectId, Space: vevSpace });
  return editMaterialListFromSearchResult(search).find((item) => {
    const source = String(item?.Source || item?.source || item?.BasicInfo?.Source || '').trim();
    return materialLooksLikeSubtitle(item)
      && (!filename || readMaterialName(item) === filename)
      && (!vevSource || source === vevSource || !source);
  }) || null;
}

async function handleOriginImportSubtitles(payload = {}) {
  if (!activeVevProjectId || !activeVevGroupId) {
    throw createSubtitleImportError(
      'subtitle_project_not_ready',
      'project_not_ready',
      'VevDemo project is not ready for subtitle import',
      {
        hasProjectId: Boolean(activeVevProjectId),
        hasGroupId: Boolean(activeVevGroupId),
        activeOriginProjectId,
      }
    );
  }

  const filename = String(payload?.filename || '').trim();
  const srtText = String(payload?.srtText || '');
  const originProjectId = String(payload?.originProjectId || '').trim();
  const vevSpace = String(payload?.vevSpace || 'origin').trim() || 'origin';
  if (!filename || !srtText.trim()) {
    throw createSubtitleImportError('subtitle_payload_invalid', 'payload_invalid', 'Subtitle payload is empty', { filename, hasText: Boolean(srtText.trim()) });
  }

  const typeInfo = getType('srt');
  if (typeInfo?.type !== 'subtitle' || typeInfo?.fileType !== 'object') {
    throw createSubtitleImportError('subtitle_srt_type_unresolved', 'type_unresolved', 'SRT subtitle material type is not configured', { typeInfo });
  }

  const existing = await findSubtitleMaterialByName(activeVevProjectId, vevSpace, filename);
  if (existing) {
    const editMid = readMaterialEditMid(existing);
    const readBack = await readBackSubtitleMaterial({ projectId: activeVevProjectId, vevSpace, filename, editMid, vevSource: String(existing.Source || existing.source || '').trim() });
    if (!readBack) {
      throw createSubtitleImportError('subtitle_readback_failed', 'readback_missing', 'Existing subtitle material was not readable after name match', { filename, editMid });
    }
    rememberSubtitleMaterialTitle({
      filename,
      originProjectId,
      vevSource: String(existing.Source || existing.source || readBack?.Source || readBack?.source || '').trim(),
      editMid: editMid || readMaterialEditMid(readBack),
      material: readBack || existing,
    });
    return {
      ok: true,
      reused: true,
      filename,
      originProjectId,
      editMid: editMid || readMaterialEditMid(readBack),
    };
  }

  const file = new File([srtText], filename, { type: 'subtitle/srt' });
  const uploadResult = await uploadSubtitleFile(file, vevSpace);
  const sourceInfo = extractSupportedSubtitleVevSource(uploadResult);
  if (!sourceInfo.vevSource) {
    throw createSubtitleImportError(
      'upload_result_missing_source',
      'upload_result_missing_source',
      'Subtitle upload completed but did not return a supported VevDemo source',
      {
        filename,
        originProjectId,
        oid: sourceInfo.oid || '',
        mid: sourceInfo.mid || '',
      }
    );
  }

  const material = {
    id: filename,
    title: filename,
    name: filename,
    type: 'subtitle',
    vevProjectId: activeVevProjectId,
    vevSpace,
    vevSource: sourceInfo.vevSource,
  };
  const registered = await registerOriginMaterialToVevDemo(material);
  if (!registered?.ok) {
    throw createSubtitleImportError(
      'create_subtitle_material_failed',
      registered?.reason || 'create_edit_material_failed',
      registered?.reason || 'CreateEditMaterial for subtitle failed',
      { registered }
    );
  }

  const readBack = await readBackSubtitleMaterial({
    projectId: activeVevProjectId,
    vevSpace,
    filename,
    editMid: registered.editMid,
    vevSource: sourceInfo.vevSource,
  });
  if (!readBack) {
    throw createSubtitleImportError(
      'subtitle_readback_failed',
      'readback_missing',
      'Subtitle material was created but SearchEditMaterial did not return it',
      { filename, editMid: registered.editMid, vevSource: sourceInfo.vevSource }
    );
  }
  rememberSubtitleMaterialTitle({
    filename,
    originProjectId,
    vevSource: sourceInfo.vevSource,
    editMid: registered.editMid || readMaterialEditMid(readBack),
    material: readBack,
  });

  return {
    ok: true,
    reused: false,
    filename,
    originProjectId,
    editMid: registered.editMid || readMaterialEditMid(readBack),
    sourceKind: sourceInfo.sourceKind,
  };
}

function normalizeExportStatus(data = {}) {
  const root = data && typeof data === 'object' ? data : {};
  const result = root.Result || root.result || root.Payload || root.payload || root;
  const scoped = { root, result };
  const status = readFirst(scoped, [
    'root.status', 'root.Status', 'root.state', 'root.State',
    'result.status', 'result.Status', 'result.state', 'result.State',
  ]);
  const taskId = readFirst(scoped, [
    'root.taskId', 'root.TaskId', 'root.task_id', 'root.EditTaskId', 'root.editTaskId',
    'result.taskId', 'result.TaskId', 'result.task_id', 'result.EditTaskId', 'result.editTaskId',
  ]);
  const outputUrl = readFirst(scoped, [
    'root.outputUrl', 'root.OutputUrl', 'root.url', 'root.Url', 'root.FileUrl', 'root.fileUrl',
    'root.VideoUrl', 'root.videoUrl', 'root.ResultUrl', 'root.resultUrl',
    'result.outputUrl', 'result.OutputUrl', 'result.url', 'result.Url', 'result.FileUrl', 'result.fileUrl',
    'result.VideoUrl', 'result.videoUrl', 'result.ResultUrl', 'result.resultUrl',
  ]);
  const message = readFirst(scoped, [
    'root.message', 'root.Message', 'root.error', 'root.Error', 'root.ErrorMessage',
    'result.message', 'result.Message', 'result.error', 'result.Error', 'result.ErrorMessage',
  ]);
  const code = readFirst(scoped, [
    'root.code', 'root.Code', 'root.ErrorCode',
    'result.code', 'result.Code', 'result.ErrorCode',
  ]);
  return { status, taskId, outputUrl, message, code, raw: data };
}

function isExportComplete(normalized) {
  const text = String(normalized.status || '').toLowerCase();
  return Boolean(normalized.outputUrl) && (
    !text || ['success', 'succeed', 'complete', 'completed', 'finish', 'finished', 'done'].some((token) => text.includes(token))
  );
}

function isExportFailed(normalized) {
  const text = String(normalized.status || '').toLowerCase();
  return ['fail', 'failed', 'error', 'cancel', 'canceled', 'cancelled'].some((token) => text.includes(token));
}

function bindOriginBridge() {
  if (window.__originVevDemoBridgeBound) return;
  window.__originVevDemoBridgeBound = true;
  window.addEventListener('message', (event) => {
    const payload = event.data || {};
    if (!payload || typeof payload.type !== 'string' || !payload.type.startsWith('origin:')) return;
    const data = payload.data || {};
    switch (payload.type) {
      case 'origin:response':
        handleOriginResponse(data);
        break;
      case 'origin:ping':
        postToOrigin('vevdemo:status', {
          status: 'pong',
          requestTimestamp: data.timestamp,
          ...getBridgeState(),
        });
        break;
      case 'origin:setProject':
        activeOriginProjectId = String(data.projectId || '').trim();
        activeOriginProjectTitle = String(data.title || '').trim();
        resetOriginMaterialTitleCache(activeOriginProjectId);
        refreshOriginMaterialTitleCache(true);
        scheduleVisibleOriginProjectTitle(activeOriginProjectTitle);
        if (!data.vevProjectId || !data.vevGroupId) {
          applyOriginProjectTitle(activeOriginProjectTitle);
          postToOrigin('vevdemo:status', {
            status: 'project-binding-missing',
            originProjectId: data.projectId,
            originTitle: data.title,
            vevProjectId: null,
            vevGroupId: null,
            message: 'Origin project binding is missing; VevDemo editor creation is blocked.',
            ...getBridgeState(),
          });
          announceBridgeReady();
          break;
        }
        stopBridgeReadyAnnounce();
        const nextProjectId = String(data.vevProjectId);
        const nextGroupId = String(data.vevGroupId);
        if (nextProjectId !== activeVevProjectId || nextGroupId !== activeVevGroupId) {
          lastAppliedOriginProjectTitle = '';
          postToOrigin('vevdemo:status', {
            status: 'switching-project',
            originProjectId: data.projectId,
            originTitle: data.title,
            vevProjectId: nextProjectId,
            vevGroupId: nextGroupId,
            ...getBridgeState(),
          });
          try {
            if (veveditorInstance && typeof veveditorInstance.destroy === 'function') {
              veveditorInstance.destroy();
            }
          } catch (err) {
            console.warn('[VevDemoBridge] destroy before project switch failed:', err);
          }
          veveditorInstance = null;
          window.__vevEditorInstance = null;
          activeVevProjectId = nextProjectId;
          activeVevGroupId = nextGroupId;
          applyOriginProjectTitle(activeOriginProjectTitle)
            .finally(() => {
              window.newVeVEditor(nextProjectId, nextGroupId);
              scheduleVisibleOriginProjectTitle(activeOriginProjectTitle);
            });
          return;
        }
        applyOriginProjectTitle(activeOriginProjectTitle);
        postToOrigin('vevdemo:status', {
          status: 'origin-project-received',
          originProjectId: data.projectId,
          originTitle: data.title,
          vevProjectId: data.vevProjectId || null,
          vevGroupId: data.vevGroupId || null,
          message: data.vevProjectId
            ? 'VevDemo project is bound to the current Origin project.'
            : 'Current bridge records the Origin project but does not switch the underlying VevDemo project.',
          ...getBridgeState(),
        });
        break;
      case 'origin:getState':
        postToOrigin('vevdemo:status', {
          status: 'state',
          ...getBridgeState(),
        });
        break;
      case 'origin:importMaterials':
        handleOriginImportMaterials(data.materials);
        break;
      case 'origin:editorShortcut': {
        // 焦点在 Origin 外壳时按键收不进 iframe，由父页转发到这里。
        const handled = dispatchEditorShortcut({
          code: data.code,
          shiftKey: data.shiftKey,
          source: 'origin-forward',
        });
        if (!handled) {
          postToOrigin('vevdemo:status', {
            status: 'editor-shortcut-unhandled',
            code: data.code || '',
            ...getBridgeState(),
          });
        }
        break;
      }
      case 'origin:togglePlayback':
        dispatchEditorShortcut({ code: 'Space', source: 'origin-toggle' });
        break;
      case 'origin:applyTimeline':
        handleOriginApplyTimeline(data.plan, data.policy)
          .then((result) => postToOrigin('vevdemo:timelineApplied', {
            ok: true,
            ...result,
            ...getBridgeState(),
          }))
          .catch((err) => {
            console.warn('[VevDemoBridge] apply timeline failed:', err);
            postToOrigin('vevdemo:timelineApplied', {
              ok: false,
              error: err?.message || String(err || 'apply timeline failed'),
              code: err?.code || '',
              reason: err?.reason || '',
              details: err?.details || null,
              ...getBridgeState(),
            });
          });
        break;
      case 'origin:importSubtitles':
        handleOriginImportSubtitles(data)
          .then((result) => postToOrigin('vevdemo:subtitlesImported', {
            ok: true,
            ...result,
            ...getBridgeState(),
          }))
          .catch((err) => {
            console.warn('[VevDemoBridge] import subtitles failed:', err);
            postToOrigin('vevdemo:subtitlesImported', {
              ok: false,
              error: err?.message || String(err || 'import subtitles failed'),
              code: err?.code || '',
              reason: err?.reason || '',
              details: err?.details || null,
              ...getBridgeState(),
            });
          });
        break;
      default:
        postToOrigin('vevdemo:status', {
          status: 'message-received',
          messageType: payload.type,
          ...getBridgeState(),
        });
    }
  });
  announceBridgeReady();
}

bindOriginBridge();
installLocalUploadAutoConfirm();
installCutAutoSelectFallback();
installVevDurationLabelPolish();
installPlaybackKeyboardShortcuts();
installPlaybackHealthMonitor();
installEditorPlaybackStatePoller();
installOriginMaterialNamePolisher();
installMaterialSelectorPaginationDock();

window.newVeVEditor = (pid, gid)=>{
  const nextProjectId = String(pid || '').trim();
  const nextGroupId = String(gid || '').trim();
  if (!nextProjectId || !nextGroupId) {
    console.warn('[VevDemoBridge] blocked editor creation without project binding');
    postToOrigin('vevdemo:status', {
      status: 'project-binding-missing',
      message: 'VevDemo editor requires a bound Origin project before creation.',
      ...getBridgeState(),
    });
    announceBridgeReady();
    return null;
  }
  stopBridgeReadyAnnounce();
  activeVevProjectId = nextProjectId;
  activeVevGroupId = nextGroupId;
  veveditorInstance = new window.VeVEditor({
    container: document.getElementById('editor'),
    config: {
      projectId: nextProjectId, // 这里需要修改为实际的火山视频点播剪辑项目ID
      groupId: nextGroupId, // 这里需要修改为实际的火山视频点播剪辑Group ID
      region: VEV_REGION, // 这里需要修改为实际的火山视频点播区域，暂只支持cn-north-1区域
      autoPublish: true,
      material: {
        show: true,
        enableLocalUpload: true,
        emptyIcon: './static/upload.svg',
        uploadAccept: 'image/*,.mp3,.mp4,.webm,.srt,.vtt,.ass',
        videoAccept: '.mp4,.webm',
        showClassification: true,
        defaultClassificationId: VEV_DEFAULT_CLASSIFICATION_ID, // 默认选中的分类ID；不填或填 null 表示默认「未分类」
      },
      filter: {
        show: true,
      },
      transition: {
        show: true,
      },
      effect: {
        show: true,
      },
      text: {
        show: true,
        enableAnimation: true,
      },
      header: {
        show: true,
        isProjectNameEditable: false,
        isNavBackVisible: true,
        isProjectSubmitVisible: true,
      },
    },
    actions: importProbeWrapActions({
      searchVideo: searchOriginProjectVideos,
      mGetMaterial: mGetOriginScopedMaterial,
      describeProject,
      updateProject,
      searchEditMaterial: searchOriginScopedEditMaterial,
      getEffectList,
      submitEditTaskAsync,
      deleteEditMaterial,
      createEditMaterial: createOrReuseOriginEditMaterial,
      updateMediaPublishStatus,
      getVideoInfo: getOriginAwareVideoInfo,
      listVideoClassifications,
    }),
    handlers: {
      uploadMaterial,
      onNavBack: () => {
        // 通知 Origin 父页执行返回(回到剪辑页),不再是空壳日志。
        postToOrigin('vevdemo:navBack', getBridgeState());
      },
      onUploadMaterial: () => {
        console.log('cus-> onUploadMaterial');
        scheduleLocalUploadAutoConfirm();
      },
      onProjectSubmit: () => {
        console.log('cus-> afterProjectSubmit');
      },
    },
  });
  veveditorInstance.on(VeVEditor.Events.System.ExportStatus, (data) => {
    console.log('cus-> ExportStatus', data);
    const normalized = normalizeExportStatus(data);
    postToOrigin('vevdemo:status', {
      status: 'export-status',
      payload: data,
      normalized,
      ...getBridgeState(),
    });
    postToOrigin('vevdemo:exportStatus', {
      ...normalized,
      ...getBridgeState(),
    });
    if (isExportComplete(normalized)) {
      postToOrigin('vevdemo:exportComplete', {
        taskId: normalized.taskId,
        outputUrl: normalized.outputUrl,
        format: 'mp4',
        raw: data,
        ...getBridgeState(),
      });
    } else if (isExportFailed(normalized)) {
      postToOrigin('vevdemo:exportError', {
        taskId: normalized.taskId,
        code: normalized.code,
        message: normalized.message || 'VevDemo export failed',
        raw: data,
        ...getBridgeState(),
      });
    }
  });
  window.__vevEditorInstance = veveditorInstance;
  scheduleVisibleOriginProjectTitle(activeOriginProjectTitle);
  requestAnimationFrame(() => {
    setTimeout(notifyOriginReady, 0);
  });
};

window.destroyVeVEditor = ()=>{
  if (veveditorInstance && typeof veveditorInstance.destroy === 'function') {
    veveditorInstance.destroy();
  }
  veveditorInstance = null;
  window.__vevEditorInstance = null;
  postToOrigin('vevdemo:status', {
    status: 'destroyed',
    ...getBridgeState(),
  });
};

// ============================================================================
// 2026-06-11 从系统导入弹窗实证探针（IMPORT_DIALOG_PROBE，定案后整块删除或置 false）
// 目的：①确定按钮到底回调了哪些 actions（问题4分叉 a/b/c 定案）
//      ②分页钉底补丁的 [class*="pagination"] 选择器是否真匹配（实证A）
//      ③翻页后勾选状态是否保留（实证B，勾选普查变化会记一行）
// 形态：右下角黄色字小黑框，pointer-events:none 不挡操作，截图发回即可判读。
// ============================================================================
const IMPORT_DIALOG_PROBE = true;
let importProbeOverlayEl = null;
let importProbeTrace = ['[导入弹窗探针就绪] 打开"从系统导入"，操作过程会记录在这里'];
let importProbeDialogStatus = '弹窗：未打开';
let importProbeLastCensus = '';
const importProbeConfirmHooked = new WeakSet();

function renderImportProbeOverlay() {
  if (!IMPORT_DIALOG_PROBE) return;
  try {
    if (!importProbeOverlayEl || !importProbeOverlayEl.isConnected) {
      importProbeOverlayEl = document.createElement('div');
      importProbeOverlayEl.id = 'origin-vev-import-probe';
      importProbeOverlayEl.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:rgba(0,0,0,.88);color:#ffd166;font:11px/1.55 monospace;padding:8px 10px;border-radius:6px;max-width:480px;white-space:pre-wrap;pointer-events:none;';
      (document.body || document.documentElement).appendChild(importProbeOverlayEl);
    }
    importProbeOverlayEl.textContent = `${importProbeDialogStatus}\n────────────\n${importProbeTrace.join('\n')}`;
  } catch (_) { /* 探针绝不影响主流程 */ }
}

function traceImportProbe(line) {
  if (!IMPORT_DIALOG_PROBE) return;
  const ts = new Date().toTimeString().slice(0, 8);
  importProbeTrace.push(`${ts} ${line}`);
  if (importProbeTrace.length > 24) importProbeTrace = importProbeTrace.slice(-24);
  renderImportProbeOverlay();
  try { console.log('[ImportProbe]', line); } catch (_) {}
}

const IMPORT_PROBE_ARG_KEYS = ['Vid', 'vid', 'Vids', 'Mid', 'Mids', 'EditMids', 'Source', 'ProjectId', 'Space', 'Offset', 'Limit', 'PageSize', 'PageNum', 'ClassificationId', 'Type', 'Name', 'Title', 'Keyword'];

function importProbeBriefArgs(arg) {
  if (!arg || typeof arg !== 'object') return arg === undefined ? '' : String(arg).slice(0, 60);
  const out = {};
  IMPORT_PROBE_ARG_KEYS.forEach((k) => { if (arg[k] !== undefined && arg[k] !== '') out[k] = arg[k]; });
  try { return JSON.stringify(out).slice(0, 150); } catch (_) { return '(参数不可序列化)'; }
}

function importProbeBriefResult(result) {
  if (!result || typeof result !== 'object') return String(result).slice(0, 40);
  const out = {};
  ['Total', 'Count', 'EditMid', 'Vid', 'MaterialId', 'Id'].forEach((k) => { if (result[k] !== undefined) out[k] = result[k]; });
  ['Detail', 'VideoInfos', 'MaterialInfoList', 'EditMaterialList', 'MaterialList'].forEach((k) => {
    if (Array.isArray(result[k])) out[k] = `len${result[k].length}`;
  });
  if (result.MaterialSet && Array.isArray(result.MaterialSet.MaterialInfos)) out.MaterialSet = `len${result.MaterialSet.MaterialInfos.length}`;
  try { return JSON.stringify(out).slice(0, 120); } catch (_) { return '(结果不可序列化)'; }
}

function importProbeWrapActions(actions) {
  if (!IMPORT_DIALOG_PROBE) return actions;
  const wrapped = {};
  Object.keys(actions).forEach((name) => {
    const fn = actions[name];
    if (typeof fn !== 'function') { wrapped[name] = fn; return; }
    wrapped[name] = async (...args) => {
      const t0 = Date.now();
      traceImportProbe(`→ ${name} ${importProbeBriefArgs(args[0])}`);
      try {
        const result = await fn(...args);
        traceImportProbe(`✓ ${name} ${Date.now() - t0}ms ${importProbeBriefResult(result)}`);
        return result;
      } catch (err) {
        traceImportProbe(`✗ ${name} ${Date.now() - t0}ms ${String(err && err.message || err).slice(0, 70)}`);
        throw err;
      }
    };
  });
  return wrapped;
}

function importProbeScanDialog() {
  if (!IMPORT_DIALOG_PROBE) return;
  try {
    const dialogs = findMaterialSelectorDialogs();
    const dialog = dialogs[0] || null;
    if (!dialog) {
      if (importProbeDialogStatus !== '弹窗：未打开') {
        importProbeDialogStatus = '弹窗：未打开';
        importProbeLastCensus = '';
        renderImportProbeOverlay();
      }
      return;
    }
    const pagMatches = dialog.querySelectorAll('[class*="pagination"], [class*="Pagination"]');
    const dockApplied = dialog.querySelectorAll(`.${MATERIAL_SELECTOR_PAGINATION_CLASS}`).length;
    const inputBoxes = dialog.querySelectorAll('input[type="checkbox"]');
    const ariaBoxes = dialog.querySelectorAll('[role="checkbox"], [aria-checked]');
    const inputChecked = Array.from(inputBoxes).filter((el) => el.checked).length;
    const ariaChecked = Array.from(ariaBoxes).filter((el) => el.getAttribute('aria-checked') === 'true').length;
    let pagDesc = `pagination类名匹配:${pagMatches.length} 钉底类已挂:${dockApplied}`;
    if (pagMatches.length) {
      pagDesc += ` cls="${String(pagMatches[0].className || '').slice(0, 56)}"`;
    }
    const census = `勾选普查 input:${inputChecked}/${inputBoxes.length} aria:${ariaChecked}/${ariaBoxes.length}`;
    importProbeDialogStatus = `弹窗：打开中 | ${pagDesc}\n${census}`;
    if (census !== importProbeLastCensus) {
      if (importProbeLastCensus) traceImportProbe(`[勾选变化] ${census}`);
      importProbeLastCensus = census;
    }
    Array.from(dialog.querySelectorAll('button, [role="button"]')).forEach((btn) => {
      if (importProbeConfirmHooked.has(btn)) return;
      const text = getElementText(btn);
      if (text !== '确定' && text !== '取消') return;
      importProbeConfirmHooked.add(btn);
      btn.addEventListener('click', () => {
        traceImportProbe(`[用户点了「${text}」] 此刻${importProbeLastCensus || '勾选普查为空'}`);
      }, true);
    });
    renderImportProbeOverlay();
  } catch (err) {
    try { console.warn('[ImportProbe] scan失败:', err); } catch (_) {}
  }
}

if (IMPORT_DIALOG_PROBE) {
  window.setInterval(importProbeScanDialog, 1000);
  window.setTimeout(renderImportProbeOverlay, 1500);
}
