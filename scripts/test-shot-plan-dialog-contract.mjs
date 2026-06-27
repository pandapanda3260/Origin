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

assert(dialog.includes("assertModuleSingleton('shotPlanDialog'"), 'shotPlanDialog must use singleton guard');
assert(dialog.includes("_applyShotFieldValue"), 'dialog must reuse shots field writer');
assert(dialog.includes("_shotFieldCurrent"), 'dialog must reuse shots field reader');
assert(dialog.includes("_swapAdjacentShotSlots"), 'dialog must use shared adjacent swap helper');
assert(dialog.includes("getActiveBatchesShared"), 'dialog must check active batch lock');
assert(dialog.includes("segmentationMode = 'manual'"), 'manual regroup must mark segmentationMode');
assert(dialog.includes("groupsCover(groups"), 'manual regroup must validate complete continuous coverage');
assert(dialog.includes("idx !== expectedNext"), 'manual regroup coverage must enforce ordered continuous groups');

assert(board.includes("data-action=\"' + escapeHtml(action) + '\""), 'board action button must render data-action');
assert(board.includes("open-shot-plan-dialog"), 'board shot-plan node must open dialog');

assert(main.includes("initShotPlanDialog"), 'main must import/init shot plan dialog');
assert(main.includes("renderShotList: () => renderShotList()"), 'dialog must refresh shot list through main context');

assert(html.includes('id="btnOpenShotPlanDialog"'), 'legacy shots top actions must expose dialog entry');
assert(html.includes('"/modules/shotPlanDialog.js": "/modules/shotPlanDialog.js?v=2"'), 'import map must cache-bust shotPlanDialog');
assert(html.includes('<script type="module" src="main.js?v=368"></script>'), 'main script cache version must be bumped');
assert(html.includes('"/modules/board.js": "/modules/board.js?v=3"'), 'board import-map cache version must be bumped');
assert(html.includes('"/modules/shots.js": "/modules/shots.js?v=116"'), 'shots import-map cache version must be bumped');
assert(html.includes('styles.css?v=256'), 'styles cache version must be bumped');

assert(css.includes('.spd-overlay'), 'dialog CSS must be present');
assert(css.includes('.spd-row-main'), 'dialog row layout CSS must be present');

console.log('test-shot-plan-dialog-contract: ok');
