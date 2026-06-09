#!/usr/bin/env node
/**
 * Source contract: keyframe batch progress is rendered under the shots page title,
 * not only in the legacy storyboard diagnostic area.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const workspace = fs.readFileSync(path.join(REPO_ROOT, 'public/workspace.html'), 'utf8');
const styles = fs.readFileSync(path.join(REPO_ROOT, 'public/styles.css'), 'utf8');
const storyboard = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/storyboard.js'), 'utf8');
const main = fs.readFileSync(path.join(REPO_ROOT, 'public/main.js'), 'utf8');

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

assert(workspace.includes('id="shotsKeyframeProgress"'), 'shots page title block should expose a keyframe progress line');
assert(workspace.includes('class="shots-keyframe-progress"'), 'keyframe progress line should have a stable CSS class');
assert(styles.includes('.shots-keyframe-progress'), 'keyframe progress line should be styled');

assert(storyboard.includes('function _formatKeyframeProgress'), 'storyboard module should format keyframe progress centrally');
assert(storyboard.includes('function _showKeyframeHeaderProgress'), 'storyboard module should show keyframe progress in the header');
assert(storyboard.includes('function _hideKeyframeHeaderProgress'), 'storyboard module should hide keyframe progress on terminal states');
assert(storyboard.includes('pending * avg / _keyframeProgressConcurrency()'), 'ETA should use the configured image concurrency helper');

const reattachFirst = section(storyboard, 'function _reattachImagesBatch', 'function _reattachTailFrameBatch');
assert(reattachFirst.includes('_showKeyframeHeaderProgress(rDoneCount, rTotal, rFailCount, rStartTs)'), 'first-frame reattach should restore header progress');
assert(reattachFirst.includes('_hideKeyframeHeaderProgress();'), 'first-frame terminal reattach should hide header progress');

const reattachTail = section(storyboard, 'function _reattachTailFrameBatch', 'function _reattachPromptsBatch');
assert(reattachTail.includes('_showKeyframeHeaderProgress(tailDoneCount, tailTotal, tailFailCount, tailStartTs)'), 'tail-frame reattach should restore header progress');
assert(reattachTail.includes('_clearTailEtaR();'), 'tail-frame terminal reattach should clear header progress');

const allTail = section(storyboard, 'export async function generateAllTailFrames', 'export async function generateAllImages');
assert(allTail.includes('_showKeyframeHeaderProgress(tailProgress.done, tailProgress.total, tailProgress.fail, tailProgress.startTs)'), 'tail-frame batch generation should update header progress');
assert(allTail.includes('opts.progressState'), 'tail-frame batch generation should accept shared keyframe progress state');
assert(allTail.includes('_hideKeyframeHeaderProgress();'), 'tail-frame batch generation should hide header progress when finished');

const allFirst = section(storyboard, 'export async function generateAllImages', 'export async function confirmImages');
assert(allFirst.includes('_plannedTailKeyframeCountForProgress(groups, buttonState, tailKeyframeMode)'), 'first-frame batch generation should include planned tail keyframes in the header total');
assert(allFirst.includes('progressState: keyframeProgressState'), 'first-frame batch generation should pass shared progress into the tail batch');
assert(allFirst.includes('_showKeyframeHeaderProgress('), 'first-frame batch generation should update header progress');
assert(allFirst.includes('_hideKeyframeHeaderProgress();'), 'first-frame batch generation should hide header progress when finished');

assert(main.includes("./modules/storyboard.js?v=138"), 'main import should bump storyboard.js cache version');
assert(workspace.includes('"\/modules/storyboard.js":     "\/modules/storyboard.js?v=138"'), 'workspace import map should bump storyboard.js cache version');
assert(workspace.includes('src="main.js?v=267"'), 'workspace should bump main.js cache version');
assert(workspace.includes('styles.css?v=214'), 'workspace should bump styles.css cache version');

console.log('keyframe header progress contract ok');
