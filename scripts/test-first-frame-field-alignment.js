#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function compileTs(relPath) {
  const sourcePath = path.join(ROOT, relPath);
  return {
    sourcePath,
    code: ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: sourcePath,
    }).outputText,
  };
}

function loadVisualReferenceState() {
  const compiled = compileTs('lib/visual-reference-state.ts');
  const moduleObj = { exports: {} };
  vm.runInNewContext(
    compiled.code,
    { require, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: compiled.sourcePath },
  );
  return moduleObj.exports;
}

function section(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`);
  const end = endNeedle ? src.indexOf(endNeedle, start + startNeedle.length) : src.length;
  assert.notEqual(end, -1, `missing end marker: ${endNeedle}`);
  return src.slice(start, end);
}

const passed = [];

function record(label, fn) {
  fn();
  passed.push(label);
  console.log(`PASS  ${label}`);
}

record('buildFirstFrameRecord overrides stale frame URL and sourceHash', () => {
  const { buildFirstFrameRecord } = loadVisualReferenceState();
  const recordValue = buildFirstFrameRecord(
    {
      frames: {
        first: {
          url: '/api/images/file/old',
          sourceHash: 'old-hash',
          mode: 'structured_v1',
          retainedMeta: true,
        },
      },
    },
    {
      url: '/api/images/file/new',
      prompt: 'submitted',
      originalPrompt: 'base',
      mode: 'legacy_pencil',
      status: 'legacy_sketch_only',
      source: 'generated',
      generatedAt: '2026-06-17T00:00:00.000Z',
      sourceHash: null,
      shotIndices: [0],
    },
  );

  assert.equal(recordValue.url, '/api/images/file/new');
  assert.equal(recordValue.sourceHash, null);
  assert.equal(recordValue.mode, 'legacy_pencil');
  assert.equal(recordValue.status, 'legacy_sketch_only');
  assert.deepEqual(recordValue.shotIndices, [0]);
  assert.equal(recordValue.retainedMeta, true);
});

record('drift alignment uses firstFrame.currentUrl and preserves history', () => {
  const { alignStoryboardFirstFrameUrlsIfDrift } = loadVisualReferenceState();
  const history = [{ url: '/api/images/file/old' }, { url: '/api/images/file/third' }];
  const result = alignStoryboardFirstFrameUrlsIfDrift({
    url: '/api/images/file/third',
    imageUrl: '/api/images/file/new',
    rawUrl: '/api/images/file/third',
    firstFrameUrl: '/api/images/file/old',
    firstFrame: {
      currentUrl: '/api/images/file/new',
      rawUrl: '/api/images/file/new',
      lastKnownGoodUrl: '/api/images/file/old',
    },
    frames: {
      first: {
        url: '/api/images/file/old',
        status: 'ready',
        retainedMeta: true,
      },
    },
    imageHistory: history,
  });

  assert.equal(result.changed, true);
  assert.equal(result.canonicalUrl, '/api/images/file/new');
  assert.equal(result.storyboard.url, '/api/images/file/new');
  assert.equal(result.storyboard.imageUrl, '/api/images/file/new');
  assert.equal(result.storyboard.rawUrl, '/api/images/file/new');
  assert.equal(result.storyboard.firstFrameUrl, '/api/images/file/new');
  assert.equal(result.storyboard.firstFrame.currentUrl, '/api/images/file/new');
  assert.equal(result.storyboard.firstFrame.rawUrl, '/api/images/file/new');
  assert.equal(result.storyboard.firstFrame.lastKnownGoodUrl, '/api/images/file/new');
  assert.equal(result.storyboard.frames.first.url, '/api/images/file/new');
  assert.equal(result.storyboard.frames.first.retainedMeta, true);
  assert.equal(result.storyboard.imageHistory, history);
});

record('drift alignment does not clean top-level URLs without first-frame URL conflict', () => {
  const { alignStoryboardFirstFrameUrlsIfDrift } = loadVisualReferenceState();
  const storyboard = {
    url: '/api/images/file/third',
    imageUrl: '/api/images/file/third',
    rawUrl: '/api/images/file/third',
    firstFrameUrl: '/api/images/file/new',
    firstFrame: { currentUrl: '/api/images/file/new' },
    frames: { first: { url: '/api/images/file/new' } },
  };
  const result = alignStoryboardFirstFrameUrlsIfDrift(storyboard);
  assert.equal(result.changed, false);
  assert.equal(result.storyboard, storyboard);
});

record('legacy pencil writeback persists frames.first for first-frame readers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/batch-executors.ts'), 'utf8');
  const block = section(
    src,
    'const frameFirst = buildFirstFrameRecord(prev, {',
    "'legacy-storyboard-image-writeback'",
  );
  assert.match(block, /mode:\s*'legacy_pencil'/);
  assert.match(block, /status:\s*'legacy_sketch_only'/);
  assert.match(block, /sourceHash:\s*null/);
  assert.match(block, /frames:\s*\{/);
  assert.match(block, /first:\s*frameFirst/);
});

record('first-frame history restore aligns current rawUrl to restored historyUrl', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/api/frames/set-current-from-history/route.ts'), 'utf8');
  const block = section(
    src,
    'const previousHistoryItem = previousUrl',
    'const nextStoryboard = {',
  );
  assert.match(block, /\.\.\.\(prev\.rawUrl && prev\.rawUrl !== previousUrl \? \{ rawUrl: prev\.rawUrl \} : \{\}\)/);
  assert.match(block, /const rawUrl = historyUrl;/);
  assert.doesNotMatch(block, /const rawUrl = cleanUrl\(historyItem\.rawUrl\) \|\| historyUrl;/);
});

record('client first-frame mirror writes frames.first only inside first-frame branch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/modules/storyboard.js'), 'utf8');
  const fn = section(src, 'function _applyStoryboardImageFields', '/**');
  const branch = section(fn, 'if (extra.firstFrameUrl || extra.firstFrameMode) {', 'if (extra.firstFramePrompt)');
  const beforeBranch = fn.slice(0, fn.indexOf('if (extra.firstFrameUrl || extra.firstFrameMode) {'));
  const afterBranch = fn.slice(fn.indexOf('if (extra.firstFramePrompt)'));

  assert.match(branch, /existing\.frames = Object\.assign\(\{\}, existing\.frames \|\| \{\}, \{ first: frameFirst \}\);/);
  assert.doesNotMatch(beforeBranch, /frames\s*=.*first|frames\.first/);
  assert.doesNotMatch(afterBranch, /frames\s*=.*first|frames\.first/);
});

record('storyboard reattach applies the current task patch even when imageUrl already exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/modules/storyboard.js'), 'utf8');
  const block = section(src, 'function _applyReattachedImageTask(t)', 'tasks.forEach(_applyReattachedImageTask);');
  assert.doesNotMatch(block, /if \(project\.storyboards\[gIdx\]\.imageUrl\)/);
  assert.match(block, /_applyStoryboardImageFields\(project\.storyboards\[gIdx\], url, extra, target\.shotIndices \|\| null\);/);
  assert.match(block, /var displayUrl = isFirstFramePatch \? \(_firstFrameImageUrl\(project\.storyboards\[gIdx\]\) \|\| url\) : url;/);
});

record('project PUT first-frame consistency is gated by storyboards and If-Match version', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/api/projects/[id]/route.ts'), 'utf8');
  const helper = section(src, 'function applyProjectPutFirstFrameConsistency', 'function applyProjectPutConsistency');
  const pipeline = section(src, 'function applyProjectPutConsistency', '// `If-Match`');
  assert.match(helper, /hasOwnProperty\.call\(patch, 'storyboards'\)/);
  assert.match(helper, /Array\.isArray\(patch\.storyboards\)/);
  assert.match(helper, /typeof opts\?\.expectedVersion !== 'number'/);
  assert.match(helper, /currentVersion !== opts\.expectedVersion/);
  assert.match(helper, /alignStoryboardFirstFrameUrlsIfDrift\(storyboard\)/);
  assert.match(pipeline, /applyProjectPutCharacterConsistency/);
  assert.match(pipeline, /applyProjectPutWorldConsistency/);
  assert.match(pipeline, /applyProjectPutFirstFrameConsistency\(current, withWorldConsistency, opts\)/);
});

console.log(`\nfirst-frame field alignment checks ok (${passed.length} checks)`);
