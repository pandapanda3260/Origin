#!/usr/bin/env node
/**
 * Source contract: moderation-blocked image failures must not claim that an
 * automatic rewrite happened unless the safety audit actually has rewriteDiff.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..');
const batches = fs.readFileSync(path.join(REPO_ROOT, 'lib/batches.ts'), 'utf8');
const storyboard = fs.readFileSync(path.join(REPO_ROOT, 'public/modules/storyboard.js'), 'utf8');

const passed = [];
const failed = [];

function record(label, fn) {
  try {
    fn();
    passed.push(label);
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed.push({ label, err });
    console.error(`FAIL  ${label}`);
    console.error(err.stack || err.message);
  }
}

function section(src, start, end) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

record('backend main failure sentence no longer unconditionally claims rewrite fallback failed', () => {
  const fn = section(batches, 'function _userFacingImageFailureMessage', 'function _clearFailedStoryboardImageState');
  assert(!fn.includes('自动改写也未能规避'));
  assert(fn.includes('提示词或参考图被图像服务判定为敏感/违规内容。${_imageSafetyAuditHint(imageSafetyAudit)}'));
});

record('backend rewrite wording stays only in the safety audit hint branch', () => {
  const hint = section(batches, 'function _imageSafetyAuditHint', 'function _userFacingImageFailureMessage');
  assert(hint.includes('系统已自动改写并重试，仍被拦截'));
  assert(hint.includes('rewriteDiff'));
});

record('frontend live safety hint matches backend rewrite/no-rewrite meaning', () => {
  const hint = section(storyboard, 'function _imageSafetyAuditHint(audit)', 'function _frameSafetyInfo');
  assert(hint.includes('系统已自动改写并重试，仍被拦截'));
  assert(hint.includes('图像服务未返回具体拦截词；建议先弱化'));
  assert(!hint.includes('自动改写后仍被拦截'));
  assert(hint.includes('rewriteDiff'));
});

if (failed.length) {
  console.error(`\n${failed.length} image moderation failure copy contract checks failed.`);
  process.exit(1);
}

console.log(`\nimage moderation failure copy contract ok (${passed.length} checks)`);
