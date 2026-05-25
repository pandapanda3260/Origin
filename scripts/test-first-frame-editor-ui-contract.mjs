import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/storyboard.js', import.meta.url), 'utf8');
const materialPanelSource = readFileSync(new URL('../public/modules/material_image_panel.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const assetsSource = readFileSync(new URL('../public/modules/assets.js', import.meta.url), 'utf8');
const utilsSource = readFileSync(new URL('../public/modules/utils.js', import.meta.url), 'utf8');

assert.match(
  source,
  /var FIRST_FRAME_REWRITE_CHAT_ENABLED = false;/,
  'first-frame rewrite chat must be disabled by default',
);

assert.match(
  source,
  /function _ffeRewriteChatSectionHtml\(chatDisabled\) \{[\s\S]*?if \(!FIRST_FRAME_REWRITE_CHAT_ENABLED\) return '';/,
  'first-frame rewrite chat renderer must return no UI while disabled',
);

assert.match(
  source,
  /_ffePanelHtml\('图片展示区域'[\s\S]*?_ffeNegativePromptPanelHtml\(payload\)[\s\S]*?_ffeRewriteChatSectionHtml\(chatDisabled\)/,
  'first-frame modal must route chat rendering through the disabled rewrite-chat section helper',
);

assert.match(
  source,
  /function _ffeFieldStatusHtml\(field\)[\s\S]*?data-ffe-status-field/,
  'first-frame prompt fields must render independent save-status badges',
);

assert.match(
  source,
  /_ffePanelHtml\('提示词展示区域'[\s\S]*?_ffeFieldMetaHtml\('promptOverride'/,
  'positive prompt panel must wrap its save-status badge in the field-meta container (counter + status)',
);

assert.match(
  source,
  /_ffePanelHtml\('负向提示词展示区域'[\s\S]*?_ffeFieldMetaHtml\('negativePromptOverride'/,
  'negative prompt panel must wrap its save-status badge in the field-meta container (counter + status)',
);

assert.match(
  source,
  /function _ffeFieldMetaHtml\(field, payload\)[\s\S]*?_ffeFieldCounterHtml\(field, payload\)[\s\S]*?_ffeFieldStatusHtml\(field\)/,
  'field-meta container must compose counter on the left and status badge on the right',
);

assert.match(
  source,
  /function _ffeFieldCounterHtml\(field, payload\)[\s\S]*?data-ffe-counter-field/,
  'prompt fields must render a live character counter element',
);

assert.match(
  source,
  /var FFE_PROMPT_OVERRIDE_MAX_CHARS = 5000;/,
  'first-frame prompt override client limit must match the temporary provider-facing cap',
);

assert.match(
  source,
  /data-ffe-field="promptOverride" maxlength="' \+ FFE_PROMPT_OVERRIDE_MAX_CHARS \+ '"/,
  'positive prompt textarea must enforce the shared prompt override maxlength',
);

assert.match(
  source,
  /data-ffe-field="negativePromptOverride" maxlength="' \+ FFE_NEGATIVE_PROMPT_MAX_CHARS \+ '"/,
  'negative prompt textarea must enforce the shared negative prompt maxlength',
);

assert.match(
  source,
  /function _ffeSetFieldCounter\(field\)[\s\S]*?data-ffe-counter-field/,
  'character counter must be updatable in place via _ffeSetFieldCounter',
);

assert.match(
  source,
  /function _ffeUpdateDirtyState\(\)[\s\S]*?_ffeSetFieldCounter\('promptOverride'\)[\s\S]*?_ffeSetFieldCounter\('negativePromptOverride'\)/,
  'dirty-state refresh must also refresh both field counters so the displayed length stays in sync with the DOM',
);

assert.match(
  source,
  /function _ffeCollectDraft\(\)[\s\S]*?auto\.touched[\s\S]*?promptOverride/,
  'prompt override collection must rely on explicit field touch state, not final-prompt text equality',
);

assert.match(
  source,
  /async function _openFirstFrameEditor\(gIdx\)[\s\S]*?_renderFirstFrameEditor\(payload, gIdx, false\)/,
  'opening the first-frame editor must not let the loading modal preserve an empty local draft over the server draft',
);

assert.match(
  source,
  /FFE_AUTOSAVE_DEBOUNCE_MS = 800[\s\S]*?FFE_AUTOSAVE_MAX_WAIT_MS = 4000/,
  'first-frame text auto-save must use the agreed debounce and max-wait cadence',
);

assert.match(
  source,
  /function _ffeFlushAutoSaveOnPageHide\(\)[\s\S]*?fetch\('\/api\/frames\/edit-draft'[\s\S]*?method: 'PUT'[\s\S]*?keepalive: true/,
  'pagehide autosave fallback must fire a keepalive PUT to the existing edit-draft endpoint',
);

assert.match(
  source,
  /function _ffeFlushAutoSaveOnPageHide\(\)[\s\S]*?force: true/,
  'pagehide autosave fallback must force-save because the user cannot resolve 409 conflicts while leaving',
);

assert.doesNotMatch(
  source,
  /function _ffeFlushAutoSaveOnPageHide\(\)[\s\S]{0,1200}frameType/,
  'pagehide autosave fallback body must only include fields read by the PUT route',
);

assert.doesNotMatch(
  source,
  /sendBeacon/,
  'first-frame pagehide autosave must not use sendBeacon because the edit-draft route is PUT-only',
);

assert.match(
  source,
  /window\.addEventListener\('beforeunload'[\s\S]*?ev\.returnValue = ''/,
  'beforeunload must only warn about unsaved first-frame edits instead of attempting async save',
);

assert.match(
  source,
  /function _ffeFlushAutoSave\(options\)[\s\S]*?while \(guard < 8\)[\s\S]*?_ffeHasAutoSaveChanges/,
  'flushAutoSave must loop until the pending draft catches up with the saved draft',
);

assert.match(
  source,
  /compositionstart[\s\S]*?auto\.composing = true[\s\S]*?compositionend[\s\S]*?auto\.composing = false/,
  'first-frame auto-save must pause during IME composition and resume after compositionend',
);

assert.match(
  source,
  /document\.addEventListener\('blur'[\s\S]*?_ffeScheduleAutoSave\(\{ source: 'autosave-blur', immediate: true \}\)/,
  'first-frame prompt blur must trigger an immediate auto-save schedule',
);

assert.doesNotMatch(
  source,
  /data-ffe-action="save-draft"|保存编辑|丢弃草稿/,
  'first-frame editor must remove the manual save button and old discard-copy',
);

assert.match(
  source,
  /data-ffe-action="restore-initial"[\s\S]*?恢复初始/,
  'first-frame editor must expose restore-initial as the draft reset action',
);

assert.match(
  source,
  /async function _generateFirstFrameFromEditor[\s\S]*?_ffeFlushAutoSave\(\{ source: 'autosave-generate' \}\)/,
  'regenerate must flush text auto-save before starting generation',
);

assert.match(
  source,
  /function _ffeInitialEditorState\(overrides\)[\s\S]*?generateBlock: null/,
  'first-frame editor state must initialize generateBlock for inline generation blockers',
);

assert.match(
  source,
  /function _ffeSetGenerateBlock\(message, meta\)[\s\S]*?function _ffeClearGenerateBlock\(\)/,
  'first-frame editor must expose helpers for setting and clearing inline generation blockers',
);

assert.match(
  source,
  /function _ffeModalHtml\(payload, gIdx\)[\s\S]*?var generateBlock = _firstFrameEditor\.generateBlock[\s\S]*?ffe-alert-stack/,
  'first-frame modal alert stack must render generateBlock messages inline',
);

assert.match(
  source,
  /async function _fetchSingleFirstFramePreflightPayload\(gIdx, group\)/,
  'single first-frame preflight should be split into a raw payload fetch helper',
);

assert.match(
  source,
  /async function _ffeEnsureFirstFramePreflightAllowed\(gIdx\)[\s\S]*?_ffeSetGenerateBlock\(_firstFramePreflightMessage\(payload\)/,
  'modal regenerate preflight blocks must be shown through generateBlock, not toast-only feedback',
);

assert.match(
  source,
  /async function _generateFirstFrameFromEditor[\s\S]{0,240}var gIdx = _firstFrameEditor\.groupIdx/,
  'regenerate must capture gIdx before early-return rendering paths',
);

assert.match(
  source,
  /async function _generateFirstFrameFromEditor[\s\S]*?_ffeEnsureFirstFramePreflightAllowed\(gIdx\)/,
  'modal regenerate must run its own inline preflight check before starting generation',
);

assert.match(
  source,
  /async function _generateFirstFrameFromEditor[\s\S]*?skipPreflight: true[\s\S]*?skipPreflight: true/,
  'modal regenerate must pass skipPreflight on both initial start and stale retry starts',
);

assert.match(
  source,
  /async function _generateFirstFrameFromEditor[\s\S]*?onStartError: function \(err\)[\s\S]*?onStartError: function \(err\)/,
  'modal regenerate must attach start-error handlers to both initial start and stale retry starts',
);

assert.match(
  source,
  /async function _generateFirstFrameFromEditor[\s\S]*?onStartError: function \(err\)[\s\S]*?renderImageGrid\(\)[\s\S]*?onStartError: function \(err\)[\s\S]*?renderImageGrid\(\)/,
  'modal regenerate start-error handlers must reset the storyboard grid to avoid stale loading cards',
);

assert.doesNotMatch(
  source,
  /retryStale[\s\S]{0,300}_generateFirstFrameFromEditor\(\s*true/,
  'stale edit-draft retry must not recursively re-enter _generateFirstFrameFromEditor while generating',
);

assert.match(
  source,
  /if \(retryStale\)\s*\{[\s\S]*?generateStoryboardSheet\(gIdx/,
  'stale edit-draft retry must start a second storyboard generation request in the same flow',
);

assert.match(
  source,
  /async function _closeFirstFrameEditor[\s\S]*?_ffeFlushAutoSave\(\{ source: 'autosave-close' \}\)/,
  'closing the first-frame editor must flush pending auto-save before closing',
);

assert.match(
  source,
  /function _ffeApplyPlanAutoSaveFlags\(payload\)[\s\S]*?legacy_style_rules_merged[\s\S]*?forceSaveOnce/,
  'legacy style-rule migration notices must force one auto-save pass',
);

assert.match(
  source,
  /function _ffeApplyDraftSaveResponse\(resp, options\)[\s\S]*?baselineDraftJson = savedJson[\s\S]*?baselineFingerprint/,
  'auto-save success must roll forward both AI baseline draft and baseline fingerprint',
);

assert.match(
  source,
  /async function _applyDraftToEditor[\s\S]*?_ffeRunOneSaveCycle\(\{[\s\S]*?draftOverride: nextDraft[\s\S]*?source: 'ai-apply'/,
  'AI apply must immediately persist the accepted draft through the auto-save save path',
);

assert.match(
  source,
  /async function _ffeRetryAutoSaveWithConflictPrompt\(\)[\s\S]*?草稿在另一处被修改[\s\S]*?force: true/,
  'auto-save retry must expose an explicit overwrite path for saved-draft conflicts',
);

assert.match(
  source,
  /async function _restoreFirstFrameInitial\(\)[\s\S]*?payload\.code === 'saved_draft_changed'[\s\S]*?继续恢复初始并覆盖远端草稿[\s\S]*?force: true/,
  'restore-initial DELETE conflicts must ask before retrying with force',
);

assert.doesNotMatch(
  source,
  /_ffePanelHtml\('图片展示'[\s\S]{0,2500}_ffePanelHtml\('对话区'/,
  'first-frame modal must not render the rewrite chat panel directly',
);

assert.match(
  source,
  /function _ffeImagePreviewEyebrow\(payload\)[\s\S]*?_ffeImageSizeForRatio\(ratio\)[\s\S]*?IMAGE PREVIEW/,
  'first-frame image panel eyebrow must include the image ratio and derived resolution',
);

assert.doesNotMatch(
  source,
  /_ffeParamGridHtml|参数规则|ADVANCED SETTINGS|ffe-settings-column/,
  'first-frame editor must not render the removed parameter display column',
);

assert.match(
  styles,
  /\.toast-container\s*\{[\s\S]*?z-index:\s*10100\b/,
  'toast container must stack above the first-frame modal and asset lightbox',
);

assert.doesNotMatch(
  source,
  /styleRuleOverrides|ffe-style-rules-textarea|_ffeStyleRulesHtml|_ffeAdvancedSettingsHtml|ffe-note-box|局部风格规则/,
  'first-frame editor must not expose the removed style-rule display or input channel',
);

assert.match(
  source,
  /var notices = Array\.isArray\(payload\.notices\)[\s\S]*?notice\.message \|\| notice\.code[\s\S]*?ffe-warning/,
  'first-frame editor must surface plan notices through the warning banner stack',
);

assert.doesNotMatch(
  source,
  /点击选择补充参考图|确认补充|暂无补充参考|data-ffe-ref-exclude/,
  'first-frame editor must not render the old supplement-reference picker or checkbox exclusion UI',
);

assert.match(
  source,
  /from '\.\/material_image_panel\.js\?v=\d+';/,
  'first-frame editor must import the shared material panel renderer',
);

assert.match(
  materialPanelSource,
  /export function renderMaterialImagePanelHtml\(opts\)[\s\S]*?var displayCap = Number\(cap \|\| 0\)[\s\S]*?ffe-material-budget/,
  'shared material panel renderer must render the backend panel with the effective reference cap denominator',
);

assert.match(
  source,
  /function _ffeMaterialPanelHtml\(payload\)[\s\S]*?renderMaterialImagePanelHtml\(\{[\s\S]*?scope: 'editor'[\s\S]*?actionAttr: 'data-ffe-action'/,
  'first-frame material panel must delegate to the shared renderer with editor-scoped ffe actions',
);

assert.match(
  materialPanelSource,
  /export function renderMaterialImagePanelHtml\(opts\)[\s\S]*?addBoxHtml\(panel, opts\)[\s\S]*?ffe-material-strip/,
  'shared material panel renderer must render a single ordered strip with one add entry',
);

assert.match(
  materialPanelSource,
  /--ffe-material-slot-count:\s*' \+ String\(slotCount\)/,
  'first-frame material strip must receive a dynamic slot-count CSS variable',
);

assert.match(
  materialPanelSource,
  /toggleRolePicker: 'toggle-reference-role-picker'[\s\S]*?function addBoxHtml\(panel, opts\)[\s\S]*?actionAttr\(actions\.toggleRolePicker, opts\)/,
  'shared material panel renderer must expose one add entry through the configurable action attribute',
);

assert.match(
  materialPanelSource,
  /chooseRole: 'choose-reference-upload-role'[\s\S]*?function rolePickerHtml\(opts\)[\s\S]*?actionAttr\(actions\.chooseRole, opts\)/,
  'shared material panel role picker must choose a role before opening the material picker',
);

assert.match(
  source,
  /function _ffeReferenceMaterialPickerHtml\(payload\)[\s\S]*?renderMaterialPickerHtml\(\{[\s\S]*?actionAttr: 'data-ffe-action'/,
  'first-frame material role selection must open the shared material picker with editor-scoped ffe actions',
);

assert.match(
  materialPanelSource,
  /export function renderMaterialPickerHtml\(opts\)[\s\S]*?actionAttr\(actions\.confirm, opts\)[\s\S]*?>确认<\/button>/,
  'shared material picker must render a confirm action',
);

assert.match(
  source,
  /if \(action === 'choose-reference-upload-role'\)[\s\S]*?_ffeOpenReferenceMaterialPicker\(selectedRole\)[\s\S]*?return;/,
  'choosing a reference role must open the material picker instead of immediately uploading',
);

assert.doesNotMatch(
  source,
  /if \(action === 'choose-reference-upload-role'\)[\s\S]{0,260}_ffePickAndUploadReference/,
  'choosing a reference role must not directly open the native upload dialog',
);

assert.doesNotMatch(
  source,
  /_ffePickAndUploadReference(?!Material)|_ffeUploadReferenceFiles|_ffeUploadReferenceFile|data-ffe-action="upload-reference-image"|action === 'upload-reference-image'|\/api\/frames\/reference-upload/,
  'first-frame editor frontend must not keep the old direct upload-to-selection path',
);

assert.match(
  source,
  /function _materialReferenceMutationBase\(options\)[\s\S]*?source: options\.source \|\| 'shot'[\s\S]*?baseSourceHash[\s\S]*?baseSelectionVersion/,
  'material reference mutations must be parameterized by surface instead of reading only editor state',
);

assert.match(
  source,
  /async function _persistMaterialReferenceSelection\(options\)[\s\S]*?var isEditor = base\.source === 'editor'[\s\S]*?if \(isEditor\)[\s\S]*?_ffeSaveBeforeReferenceMutation[\s\S]*?\/api\/frames\/reference-selection/,
  'reference selection mutation must only flush editor autosave for editor-sourced writes',
);

assert.match(
  source,
  /async function _ffePersistReferenceSelection\(includeIds\)[\s\S]*?_persistMaterialReferenceSelection\(\{[\s\S]*?source: 'editor'[\s\S]*?includeIds: includeIds \|\| \[\]/,
  'first-frame editor selection wrapper must call the shared selection mutation with editor scope',
);

assert.match(
  source,
  /async function _uploadMaterialReferenceFile\(options\)[\s\S]*?\/api\/frames\/reference-material-upload[\s\S]*?_applyMaterialMutationPanel/,
  'picker uploads must use the upload-only reference material endpoint through the shared upload mutation',
);

assert.match(
  source,
  /async function _ffeUploadReferenceMaterialFile\(role, file\)[\s\S]*?_uploadMaterialReferenceFile\(\{[\s\S]*?source: 'editor'[\s\S]*?file: file/,
  'first-frame editor upload wrapper must call the shared upload mutation with editor scope',
);

assert.match(
  source,
  /function _ffeApplyMaterialPanel\(panel\)[\s\S]*?setMaterialPanel\(_firstFrameEditor\.groupIdx, panel/,
  'first-frame editor panel application must also update the shared material panel cache',
);

assert.match(
  source,
  /function _ffeDisableActions\(root, actions, disabled\)[\s\S]*?computedDisabled[\s\S]*?data-disabled-computed[\s\S]*?el\.disabled = !!disabled \|\| computedDisabled/,
  'first-frame material picker computed-disabled buttons must stay disabled while real busy states still disable actions',
);

assert.match(
  materialPanelSource,
  /actionAttr\(actions\.confirm, opts\)[\s\S]*?>确认<\/button>/,
  'shared material picker confirm button must remain clickable even when the user makes no selection change',
);

assert.match(
  source,
  /async function _ffeConfirmReferenceMaterial\(\)[\s\S]*?!picker\.selectedId[\s\S]*?_renderFirstFrameEditor/,
  'confirming without a new material selection must close the picker as a no-op instead of blocking the button',
);

assert.match(
  source,
  /async function _ffeConfirmReferenceMaterial\(\)[\s\S]*?if \(ok\)[\s\S]*?picker\.open = false[\s\S]*?_renderFirstFrameEditor\(_firstFrameEditor\.payload, _firstFrameEditor\.groupIdx, false\)/,
  'confirming a newly selected material must re-render after closing picker state',
);

assert.match(
  materialPanelSource,
  /tile\.source === 'library' \? '资产库素材'/,
  'first-frame material picker must distinguish asset-library candidates from project defaults and uploads',
);

assert.match(
  utilsSource,
  /export function markImageMissing\(node\)[\s\S]*?closest\('\.ffe-image-frame'\)[\s\S]*?data-image-missing[\s\S]*?data-image-missing-disable/,
  'protected image failures must mark the nearest first-frame image frame and disable declared picker buttons',
);

assert.match(
  utilsSource,
  /wasDisabled[\s\S]*?data-image-missing-toggled[\s\S]*?disableTarget\.disabled = true[\s\S]*?disableTarget\.setAttribute\('data-image-missing', 'true'\)/,
  'missing-image disabled picker buttons must record when missing-image handling toggled disabled state',
);

assert.match(
  utilsSource,
  /function clearImageMissing\(node\)[\s\S]*?classList\.remove\('is-image-missing'\)[\s\S]*?removeAttribute\('data-image-missing'\)[\s\S]*?data-image-missing-disable[\s\S]*?data-image-missing-toggled[\s\S]*?disabled = false/,
  'successful protected-image hydration must clear stale missing-image markers and undo only missing-image toggled button disables',
);

assert.match(
  utilsSource,
  /window\.__originMarkImageMissing = markImageMissing/,
  'native image onerror handlers must share the same global missing-image marker as protected-image hydration',
);

assert.match(
  utilsSource,
  /node\.setAttribute\('src', blobUrl\);[\s\S]*?clearImageMissing\(node\)[\s\S]*?protected image hydrate failed[\s\S]*?markImageMissing\(node\)/,
  'protected img[src] hydration success must clear stale missing state and failure must mark missing state',
);

assert.match(
  utilsSource,
  /node\.setAttribute\('data-img', blobUrl\);[\s\S]*?clearImageMissing\(node\)[\s\S]*?protected data-img hydrate failed[\s\S]*?markImageMissing\(node\)/,
  'protected data-img hydration success must clear stale missing state and failure must mark missing state',
);

assert.match(
  utilsSource,
  /node\.setAttribute\('data-original-img', blobUrl\);[\s\S]*?clearImageMissing\(node\)[\s\S]*?protected original image hydrate failed[\s\S]*?markImageMissing\(node\)/,
  'protected data-original-img hydration success must clear stale missing state and failure must mark missing state',
);

assert.match(
  materialPanelSource,
  /export function renderMaterialImageWithFallbackHtml\(url, opts\)[\s\S]*?ffe-image-frame ffe-image-frame--[\s\S]*?onerror="window\.__originMarkImageMissing && window\.__originMarkImageMissing\(this\)"[\s\S]*?ffe-image-fallback/,
  'first-frame modal images must render through a shared fallback frame with native onerror handling',
);

assert.match(
  source,
  /root\.innerHTML = _ffeModalHtml\(payload, gIdx\);[\s\S]*?_ffeUpdateDirtyState\(\);[\s\S]*?hydrateProtectedImageElements\(root\);/,
  'first-frame editor render must hydrate protected images after rebuilding modal HTML',
);

assert.match(
  materialPanelSource,
  /data-image-missing-disable="true"/,
  'material picker image buttons must opt into automatic disable when their image cannot load',
);

assert.match(
  source,
  /if \(action === 'select-reference-material'\)[\s\S]*?btn\.querySelector\('\.is-image-missing, \[data-image-missing="true"\]'\)[\s\S]*?图片暂不可用，不能作为参考图[\s\S]*?'warn'/,
  'material picker selection must guard against missing-image descendants with a warn toast',
);

assert.match(
  assetsSource,
  /asset-lightbox-image-frame[\s\S]*?onerror="window\.__originMarkImageMissing && window\.__originMarkImageMissing\(this\)"[\s\S]*?ffe-image-fallback[\s\S]*?hydrateProtectedImageElements\(overlay\)/,
  'asset lightbox must wrap images in the shared fallback frame and hydrate protected URLs',
);

assert.doesNotMatch(
  source,
  /data-disabled-computed[\s\S]{0,220}disabled="disabled"/,
  'first-frame material add entry must not use native disabled for reference-cap lockout',
);

assert.match(
  materialPanelSource,
  /remove: 'remove-reference-tile'[\s\S]*?actionAttr\(actions\.remove, opts\)/,
  'first-frame material panel must expose a modal-scoped remove action',
);

assert.doesNotMatch(
  styles,
  /styleRuleOverrides|ffe-style-rules-textarea|ffe-note-box|ffe-param-grid|ffe-param-chip|ffe-settings-column|ffe-settings-layout|ffe-setting-row/,
  'first-frame editor styles must not keep dead rules for removed style-rule or parameter UI',
);

assert.doesNotMatch(
  styles,
  /\.ffe-material-panel \.sb-material-thumb-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);[\s\S]*?\}/,
  'first-frame material panel must not keep the removed fixed four-column role grid',
);

assert.match(
  styles,
  /\.ffe-material-strip\s*\{[\s\S]*?grid-template-columns:\s*repeat\(var\(--ffe-material-slot-count\)/,
  'first-frame material strip must size columns from the dynamic slot-count variable',
);

assert.match(
  styles,
  /\.ffe-image-fallback\s*\{[\s\S]*?position:\s*absolute[\s\S]*?flex-direction:\s*column[\s\S]*?justify-content:\s*center[\s\S]*?\}/,
  'first-frame missing-image fallback must be centered and vertically stacked',
);

assert.match(
  styles,
  /\.ffe-image-frame\.is-image-missing img,[\s\S]*?\.ffe-image-frame\[data-image-missing="true"\] img[\s\S]*?display:\s*none !important/,
  'missing first-frame images must hide the broken img element without relying on :has()',
);

assert.match(
  styles,
  /\.asset-lightbox-image-frame[\s\S]*?\.asset-lightbox-image-frame\.is-image-missing,[\s\S]*?\.asset-lightbox-image-frame\[data-image-missing="true"\]/,
  'asset lightbox must have a fallback-sized image frame for missing images',
);

assert.match(
  styles,
  /\.ffe-material-picker-backdrop\s*\{[\s\S]*?z-index:\s*10060\b/,
  'first-frame material picker must stack above the first-frame modal and below the asset lightbox',
);

assert.doesNotMatch(
  styles,
  /#firstFrameEditorRoot \.ffe-settings-bottom \.ffe-ref-thumbs|data-ffe-action="add-reference"/,
  'settings-bottom must not include the removed reference thumbnail selector or confirm button styling',
);

console.log('test-first-frame-editor-ui-contract passed');
