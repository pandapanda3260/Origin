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
assert(dialog.includes("_draftsByShot = new Map()"), 'dialog must keep shot edits in a draft map');
assert(dialog.includes('_returnFocusEl'), 'dialog must remember the trigger element for focus return');
assert(dialog.includes("function applyDraftToShot"), 'dialog must apply only the selected shot draft explicitly');
assert(dialog.includes('function focusInitialControl'), 'dialog must move initial focus inside the modal');
assert(dialog.includes('function trapDialogFocus'), 'dialog must trap Tab focus inside the modal');
assert(dialog.includes("event.key === 'Tab'"), 'dialog keydown handler must trap Tab navigation');
assert(dialog.includes('data-spd-list'), 'dialog must render a left shot list');
assert(dialog.includes('data-spd-detail'), 'dialog must render a right shot detail panel');
assert(dialog.includes('data-spd-action="apply-current"'), 'dialog must expose an explicit apply-current action');
assert(dialog.includes('data-spd-dirty-state'), 'dialog must render an explicit draft dirty state label');
assert(dialog.includes("dirtyState.textContent = dirty ? '有未应用修改' : '当前镜头未修改'"), 'draft dirty label must update without full render');
assert(dialog.includes('aria-selected="'), 'dialog shot list must expose selected state');
assert(dialog.includes('target.focus({ preventScroll: true })'), 'closing the dialog must restore focus without scrolling');
assert(!dialog.includes("addEventListener('focusout'"), 'dialog must not save text fields on blur');
assert(!dialog.includes('function applyField'), 'dialog must not use direct field autosave');
assert(!functionBody(dialog, 'applyDraftToShot').includes('render()'), 'applying one shot must not rebuild the whole dialog');
assert(dialog.includes("segmentationMode = 'manual'"), 'manual regroup must mark segmentationMode');
assert(dialog.includes("groupsCover(groups"), 'manual regroup must validate complete continuous coverage');
assert(dialog.includes("idx !== expectedNext"), 'manual regroup coverage must enforce ordered continuous groups');

assert(board.includes("data-action=\"' + escapeHtml(action) + '\""), 'board action button must render data-action');
assert(board.includes("open-shot-plan-dialog"), 'board shot-plan node must open dialog');

assert(main.includes("initShotPlanDialog"), 'main must import/init shot plan dialog');
assert(main.includes("renderShotList: () => renderShotList()"), 'dialog must refresh shot list through main context');

assert(html.includes('id="btnOpenShotPlanDialog"'), 'legacy shots top actions must expose dialog entry');
assert(html.includes('"/modules/shotPlanDialog.js": "/modules/shotPlanDialog.js?v=5"'), 'import map must cache-bust shotPlanDialog');
assert(html.includes('<script type="module" src="main.js?v=369"></script>'), 'main script cache version must be bumped');
assert(html.includes('"/modules/asset_display_state.js": "/modules/asset_display_state.js?v=1"'), 'asset_display_state import-map cache version must be present');
assert(html.includes('"/modules/board.js": "/modules/board.js?v=7"'), 'board import-map cache version must be bumped');
assert(html.includes('"/modules/board_state.js": "/modules/board_state.js?v=3"'), 'board_state import-map cache version must be bumped');
assert(html.includes('"/modules/board_viewport.js": "/modules/board_viewport.js?v=3"'), 'board_viewport import-map cache version must be bumped');
assert(html.includes('"/modules/shots.js": "/modules/shots.js?v=116"'), 'shots import-map cache version must be bumped');
assert(html.includes('styles.css?v=261'), 'styles cache version must be bumped');

assert(css.includes('.spd-overlay'), 'dialog CSS must be present');
assert(css.includes('.spd-workbench'), 'dialog split workbench CSS must be present');
assert(css.includes('.spd-shot-list'), 'dialog left shot list CSS must be present');
assert(css.includes('.spd-detail-panel'), 'dialog right detail CSS must be present');
assert(css.includes('.spd-apply-btn'), 'dialog explicit apply button CSS must be present');

console.log('test-shot-plan-dialog-contract: ok');
