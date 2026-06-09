#!/usr/bin/env node
/**
 * Source contract: the shots generation banner must not survive project switches
 * when the newly active project is not generating a shot plan.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const shots = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/shots.js'), 'utf8');
const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

const syncBlock = section(shots, 'export function syncShotsProject(p)', 'function _syncRefs()');
assert(syncBlock.includes('_syncShotsProgressBanner();'), 'project sync should reset stale shots banner');

const hideBlock = section(shots, 'function _hideShotsProgressBanner()', 'function _syncShotsProgressBanner()');
assert(hideBlock.includes('banner.hidden = true;'), 'hide helper should hide the banner');
assert(hideBlock.includes('bar.style.width = "0%";'), 'hide helper should reset progress width');
assert(hideBlock.includes('bar.classList.remove("extract-bar-pulse");'), 'hide helper should stop pulse animation');

const guardBlock = section(shots, 'function _syncShotsProgressBanner()', '/* ----------------------------------------------------------------');
assert(guardBlock.includes('project.shotPlanStatus !== "generating"'), 'banner reset should preserve real generating state');
assert(guardBlock.includes('_hideShotsProgressBanner();'), 'non-generating projects should hide the banner');

const refreshBlock = section(shots, 'export function refreshShotsPage()', 'export function _buildSelectOptions');
assert(refreshBlock.includes('_syncShotsProgressBanner();'), 'shots page refresh should clear stale banner');

const renderBlock = section(shots, 'export function renderShotList()', 'function _renderScriptRefPanel');
assert(renderBlock.includes('_syncShotsProgressBanner();'), 'shot list render should clear stale banner');

assert(/\.\/modules\/shots\.js\?v=\d+/.test(main), 'main import should carry a shots.js cache-bust version');

console.log('shots progress banner reset contract ok');
