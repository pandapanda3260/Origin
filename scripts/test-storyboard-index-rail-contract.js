#!/usr/bin/env node
/**
 * Source contract: the shot index rail owns its current-shot highlight state.
 * It must initialize on page entry, track window scroll, and suppress intermediate
 * highlights during programmatic smooth scrolling.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const storyboard = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/storyboard.js'), 'utf8');
const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');
const workspace = fs.readFileSync(path.join(REPO_ROOT, 'public/workspace.html'), 'utf8');

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

assert(storyboard.includes('var SB_INDEX_RAIL_ANCHOR_EPSILON = 2;'), 'rail viewport matching should use an explicit epsilon');
assert(storyboard.includes('var _sbIndexRailProgrammaticScrolling = false;'), 'rail smooth scroll should have an independent programmatic flag');
assert(storyboard.includes('var _sbIndexRailViewportSyncBound = false;'), 'rail viewport sync should be bound once');
assert(storyboard.includes('var _sbIndexRailResizeObserver = null;'), 'rail should observe shot list height changes');

const activeBlock = section(storyboard, 'function _setStoryboardIndexRailActive', 'function _setStoryboardIndexRailFailureForGroup');
assert(activeBlock.includes('_sbIndexRailActiveShotIdx = shotIdx;'), 'active helper should own the cached active shot index');
assert(activeBlock.includes('btn.classList.toggle("is-active"'), 'active helper should be the classList writer');
assert(!activeBlock.includes('if (_sbIndexRailActiveShotIdx === shotIdx) return;'), 'active helper must always write DOM classes after rail re-render');

const viewportBlock = section(storyboard, 'function _storyboardIndexRailAnchorY', 'function _scrollToShotCardFromRail');
assert(viewportBlock.includes('anchorY + SB_INDEX_RAIL_ANCHOR_EPSILON'), 'viewport matching should use the epsilon constant');
assert(viewportBlock.includes('if (!rail || rail.hidden) return;'), 'viewport sync should no-op when rail is hidden');
assert(viewportBlock.includes('if (!_shotCardsForIndexRail().length) return;'), 'viewport sync should no-op when no shot cards exist');
assert(viewportBlock.includes('requestAnimationFrame(function ()'), 'viewport sync should be requestAnimationFrame-throttled');
assert(viewportBlock.includes('if (reposition) _positionStoryboardIndexRail();'), 'resize path should only reposition then resync');
assert(viewportBlock.includes('window.addEventListener("scroll"'), 'rail should subscribe to window scroll');
assert(viewportBlock.includes('_scheduleStoryboardIndexRailViewportSync();'), 'scroll handler should delegate to the scheduler');
assert(viewportBlock.includes('window.addEventListener("resize"'), 'rail should subscribe to window resize');
assert(viewportBlock.includes('_scheduleStoryboardIndexRailViewportSync({ reposition: true });'), 'resize should request reposition and resync');
assert(viewportBlock.includes('new ResizeObserver(function ()'), 'rail should observe shot list layout changes');
assert(viewportBlock.includes('_sbIndexRailResizeObserver.observe(root);'), 'rail ResizeObserver should observe shotListWrap');
assert(viewportBlock.includes('stableFrames = (nearTarget || stable) ? stableFrames + 1 : 0;'), 'rail smooth scroll settle should unlock on near target or stable position');

const clickBlock = section(storyboard, 'function _scrollToShotCardFromRail', 'function _renderStoryboardIndexRail');
assert(clickBlock.includes('_sbIndexRailProgrammaticScrolling = true;'), 'click smooth scroll should suppress viewport active scans');
assert(clickBlock.includes('_setStoryboardIndexRailActive(shotIdx);'), 'click should immediately highlight the target shot');
assert(clickBlock.includes('_waitForIndexRailScrollSettle(Math.max(0, nextScrollY), shotIdx);'), 'click should wait for smooth scroll settlement');

const renderBlock = section(storyboard, 'function _renderStoryboardIndexRail', 'export function renderImageGrid');
assert(renderBlock.includes('_sbIndexRailActiveShotIdx = null;'), 'empty rail state should clear active shot state');
assert(renderBlock.includes('_bindStoryboardIndexRailViewportSync();'), 'render should bind rail viewport sync');
assert(renderBlock.includes('_scheduleStoryboardIndexRailViewportSync();'), 'render should initialize current-shot highlight');

assert(main.includes("./modules/storyboard.js?v=138"), 'main import should bump storyboard.js cache version');
assert(workspace.includes('"\/modules/storyboard.js":     "\/modules/storyboard.js?v=138"'), 'workspace import map should bump storyboard.js cache version');
assert(workspace.includes('src="main.js?v=267"'), 'workspace should bump main.js cache version after main import changes');
assert(workspace.includes('styles.css?v=214'), 'styles.css cache version pinned to current build (bumped for account-entry gap fix)');

console.log('storyboard index rail contract ok');
