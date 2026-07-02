import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const dialog = read('public/modules/shotPlanDialog.js');
const board = read('public/modules/board.js');
const project = read('public/modules/project.js');
const main = read('public/main.js');
const html = read('public/workspace.html');
const css = read('public/styles.css');

function functionBody(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} exists`);
  const open = source.indexOf('{', start);
  assert(open >= 0, `${name} has body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${name} body did not close`);
}

assert(dialog.includes("assertModuleSingleton('shotPlanDialog'"), 'shotPlanDialog must use singleton guard');
assert(dialog.includes("_applyShotFieldValue"), 'dialog must reuse shots field writer');
assert(dialog.includes("_shotFieldCurrent"), 'dialog must reuse shots field reader');
assert(dialog.includes("_swapAdjacentShotSlots"), 'dialog must use shared adjacent swap helper');
assert(dialog.includes("getActiveBatchesShared"), 'dialog must check active batch lock');
assert(dialog.includes("_autosaveTimers = new Map()"), 'dialog must track pending autosaves');
assert(dialog.includes("_autosaveDeltasByShot = new Map()"), 'dialog must track pending autosave field deltas');
assert(dialog.includes('_returnFocusEl'), 'dialog must remember the trigger element for focus return');
assert(dialog.includes("function applyFieldAutosave"), 'dialog must autosave individual field edits');
assert(dialog.includes('function replayAutosaveDeltaSnapshot'), 'dialog must replay local autosave edits after stale reload');
assert(dialog.includes('function focusInitialControl'), 'dialog must move initial focus inside the modal');
assert(dialog.includes('function trapDialogFocus'), 'dialog must trap Tab focus inside the modal');
assert(dialog.includes("event.key === 'Tab'"), 'dialog keydown handler must trap Tab navigation');
assert(dialog.includes('data-spd-list'), 'dialog must render a left shot list');
assert(dialog.includes('data-spd-detail'), 'dialog must render a right shot detail panel');
assert(!dialog.includes('data-spd-action="apply-current"'), 'dialog must not expose an explicit apply-current action');
assert(dialog.includes('data-spd-save-state'), 'dialog must render an explicit autosave state label');
assert(dialog.includes("'保存中'") && dialog.includes("'已保存'"), 'autosave state label must show saving and saved feedback');
assert(dialog.includes('aria-selected="'), 'dialog shot list must expose selected state');
assert(dialog.includes('target.focus({ preventScroll: true })'), 'closing the dialog must restore focus without scrolling');
assert(dialog.includes("addEventListener('focusout'"), 'dialog must flush text field autosave on blur');
assert(functionBody(dialog, 'persistAutosave').includes('onStaleReload'), 'dialog autosave must restore local edits after 409 stale reload');
assert(functionBody(dialog, 'persistAutosave').includes('staleRetryLimit: 1'), 'dialog autosave must retry once after replaying stale edits');
assert(functionBody(dialog, 'persistAutosave').includes('silent: true'), 'dialog autosave must suppress contradictory stale sync toast');
assert(!dialog.includes('function applyDraftToShot'), 'dialog must not keep the old explicit draft apply path');
assert(!dialog.includes('有未应用修改'), 'dialog must not expose stale draft dirty copy');
assert(dialog.includes("segmentationMode = 'manual'"), 'manual regroup must mark segmentationMode');
assert(dialog.includes("groupsCover(groups"), 'manual regroup must validate complete continuous coverage');
assert(dialog.includes("idx !== expectedNext"), 'manual regroup coverage must enforce ordered continuous groups');
assert(functionBody(dialog, 'renderShotListItem').includes('spd-structure-menu'), 'structure actions must live with the shot list item');
assert(!functionBody(dialog, 'renderShotDetail').includes('groupActions(groups, idx, locked)'), 'detail panel must not mix structure actions into content editing fields');
assert(functionBody(dialog, 'structureActionButton').includes('data-disabled-reason'), 'disabled structure actions must expose a reason');
assert(functionBody(dialog, 'structureActionButton').includes('<small>'), 'disabled structure actions must render visible reason copy');

assert(board.includes("data-action=\"' + escapeHtml(action) + '\""), 'board action button must render data-action');
assert(board.includes("open-shot-plan-dialog"), 'board shot-plan node must open dialog');

assert(main.includes("initShotPlanDialog"), 'main must import/init shot plan dialog');
assert(main.includes("renderShotList: () => renderShotList()"), 'dialog must refresh shot list through main context');
assert(main.includes("flushServerSave: (opts) => _flushServerSave(opts)"), 'dialog must pass autosave stale-replay options to project save');
assert(functionBody(project, '_serverSave').includes('opts.onStaleReload'), 'project save must expose stale reload replay hook');
assert(functionBody(project, '_serverSave').includes('staleRetryLimit'), 'project save must support bounded stale retry');
assert(/function _flushServerSave\(opts\)/.test(project), 'flushServerSave must accept options for autosave conflict handling');

assert(html.includes('id="btnOpenShotPlanDialog"'), 'legacy shots top actions must expose dialog entry');
assert(html.includes('"/modules/project.js": "/modules/project.js?v=112"'), 'project import-map cache version must be bumped');
assert(html.includes('"/modules/shotPlanDialog.js": "/modules/shotPlanDialog.js?v=8"'), 'import map must cache-bust shotPlanDialog');
assert(html.includes('<script type="module" src="main.js?v=374"></script>'), 'main script cache version must be bumped');
assert(html.includes('"/modules/asset_display_state.js": "/modules/asset_display_state.js?v=1"'), 'asset_display_state import-map cache version must be present');
assert(html.includes('"/modules/board.js": "/modules/board.js?v=12"'), 'board import-map cache version must be bumped');
assert(html.includes('"/modules/board_state.js": "/modules/board_state.js?v=5"'), 'board_state import-map cache version must be bumped');
assert(html.includes('"/modules/board_viewport.js": "/modules/board_viewport.js?v=3"'), 'board_viewport import-map cache version must be bumped');
assert(html.includes('"/modules/shots.js": "/modules/shots.js?v=116"'), 'shots import-map cache version must be bumped');
assert(html.includes('styles.css?v=268'), 'styles cache version must be bumped');

assert(css.includes('.spd-overlay'), 'dialog CSS must be present');
assert(css.includes('.spd-workbench'), 'dialog split workbench CSS must be present');
assert(css.includes('.spd-shot-list'), 'dialog left shot list CSS must be present');
assert(css.includes('.spd-detail-panel'), 'dialog right detail CSS must be present');
assert(css.includes('.spd-save-state'), 'dialog autosave state CSS must be present');
assert(css.includes('.spd-structure-menu'), 'dialog structure menu CSS must be present');
assert(css.includes('.spd-row-actions button small'), 'dialog disabled structure action reasons must be styled');

console.log('test-shot-plan-dialog-contract: ok');
