#!/usr/bin/env tsx
/**
 * Source contract: video-prompt batch generation and refresh reattach must share
 * one controller, avoid initial-count replay bugs, and keep terminal reattach
 * silent so recent completed batches do not repeatedly toast or rewrite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const videoPrompts = readFileSync(join(REPO_ROOT, 'public/modules/videoPrompts.js'), 'utf8');
const main = readFileSync(join(REPO_ROOT, 'public/main.js'), 'utf8');
const workspace = readFileSync(join(REPO_ROOT, 'public/workspace.html'), 'utf8');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

const passed: string[] = [];
const failed: Array<{ label: string; err: unknown }> = [];

function record(label: string, fn: () => void) {
  try {
    fn();
    passed.push(label);
    console.log(`PASS  ${label}`);
  } catch (err) {
    failed.push({ label, err });
    console.error(`FAIL  ${label}`);
    console.error(err instanceof Error ? err.stack || err.message : err);
  }
}

function section(src: string, start: string, end?: string) {
  const a = src.indexOf(start);
  assert.notEqual(a, -1, `missing start marker: ${start}`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.notEqual(b, -1, `missing end marker: ${end}`);
  return src.slice(a, b);
}

record('videoPrompts imports shared active-batch API', () => {
  const importBlock = section(videoPrompts, "import { $", "from './utils.js';");
  assert(importBlock.includes('getActiveBatchesShared'));
});

record('module-level reattach guards are shared by init and refresh', () => {
  assert(videoPrompts.includes('let _vpAttachedBatchesByKey = Object.create(null);'));
  assert(videoPrompts.includes('let _vpTerminalHandledByKey = Object.create(null);'));
  assert(videoPrompts.includes('let _vpReattachRefreshTimer = null;'));
});

record('reattach does not use initialDone or initialFailed counters', () => {
  assert(!videoPrompts.includes('initialDone'));
  assert(!videoPrompts.includes('initialFailed'));
});

record('start and reattach paths use one batch controller', () => {
  assert(videoPrompts.includes('function _attachVideoPromptBatch(opts)'));
  const startBlock = section(videoPrompts, 'export async function generateAllVideoPrompts', 'export async function confirmVideoPrompts');
  const reattachBlock = section(videoPrompts, 'export async function reattachVideoPromptBatches', 'export async function generateAllVideoPrompts');
  assert(startBlock.includes('_attachVideoPromptBatch({'));
  assert(reattachBlock.includes('_attachVideoPromptBatch({'));
});

record('reattach consumes getBatchSnapshot task shape directly', () => {
  const reattachBlock = section(videoPrompts, 'export async function reattachVideoPromptBatches', 'export async function generateAllVideoPrompts');
  assert(reattachBlock.includes('b.batchType !== "video_prompts"'));
  assert(reattachBlock.includes('var tasks = Array.isArray(b.tasks) ? b.tasks : (Array.isArray(snap.tasks) ? snap.tasks : []);'));
  assert(reattachBlock.includes('snapshotTasks: tasks'));
  assert(!videoPrompts.includes('_videoPromptTaskGroupIdx'));
  assert(!videoPrompts.includes('_videoPromptTaskPrompt'));
  assert(!videoPrompts.includes('_videoPromptTaskExtra'));
  assert(!videoPrompts.includes('_seqToVideoPromptGroup'));
  assert(!videoPrompts.includes('batch_seq'));
  assert(!videoPrompts.includes('target_type'));
});

record('terminal reattach is silent and does not subscribe', () => {
  const attachBlock = section(videoPrompts, 'function _attachVideoPromptBatch(opts)', 'function _videoPromptBatchStatus');
  assert(attachBlock.includes("var silent = source === 'reattach';"));
  assert(attachBlock.includes('if (!silent) {'));
  assert(attachBlock.includes('if (!silent) setTimeout(function () { _checkAndSuggest("videoPrompts"); }, 1000);'));
  assert(attachBlock.includes('if (!terminalAtAttach) {\n      _videoPromptsGenerating = false;\n      if (btn) btn.disabled = false;\n    }'));
  assert(attachBlock.includes('if (!terminalAtAttach && hint) {'));
  assert(attachBlock.includes('if (!terminalAtAttach) _updateVideoPromptBulkButtonLabel(groups);'));
  assert(attachBlock.includes('if (terminalAtAttach && attachKey && reloadOk) _vpTerminalHandledByKey[attachKey] = true;'));
  assert(attachBlock.includes('if (terminalAtAttach) {'));
  assert(attachBlock.includes('silent && terminalAtAttach && project.storyboards[gIdx].videoPromptStatus === "failed"'));
  const terminalBlock = section(attachBlock, 'if (terminalAtAttach) {', 'pollTimer = setInterval');
  assert(terminalBlock.includes('finish();'));
  assert(!terminalBlock.includes('subscribeBatch('));
});

record('running reattach restores the duplicate-start gate', () => {
  const reattachBlock = section(videoPrompts, 'export async function reattachVideoPromptBatches', 'export async function generateAllVideoPrompts');
  assert(reattachBlock.includes('_videoPromptsGenerating = true;'));
  assert(reattachBlock.includes('_setVideoPromptBulkButtonDisabled(true);'));
  assert(reattachBlock.includes('_setVideoPromptBulkButtonLabel("生成中…");'));
  assert(reattachBlock.includes('if (_vpTerminalHandledByKey[key] || _vpAttachedBatchesByKey[key]) return;'));
  assert(!reattachBlock.includes('_vpTerminalHandledByKey[key] = true;'));
});

record('refresh and main init both call the shared reattach path', () => {
  const refreshBlock = section(videoPrompts, 'export function refreshPromptsPage()', '// 片段条展示导演计划时长');
  assert(refreshBlock.includes('_scheduleVideoPromptBatchReattach("refresh");'));
  assert(main.includes('reattachVideoPromptBatches'));
  const initBlock = section(main, 'try { _restoreAssetGenStatus(); }', '// Phase 3-B-10');
  assert(initBlock.includes('reattachVideoPromptBatches("init")'));
});

record('workspace import map cache-busts videoPrompts module', () => {
  assert.match(workspace, /"\/modules\/videoPrompts\.js":\s*"\/modules\/videoPrompts\.js\?v=\d+"/);
});

record('npm script is registered', () => {
  assert.equal(pkg.scripts['test:video-prompt-reattach'], 'tsx scripts/test-video-prompt-batch-reattach.ts');
});

if (failed.length) {
  console.error(`\n${failed.length} video-prompt reattach contract checks failed.`);
  process.exit(1);
}

console.log(`\nvideo-prompt reattach contract ok (${passed.length} checks)`);
