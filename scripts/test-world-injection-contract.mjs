import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const batchSource = readFileSync(new URL('../lib/batch-executors.ts', import.meta.url), 'utf8');
const storyboardStart = batchSource.indexOf("registerExecutor('storyboard_prompts'");
assert.ok(storyboardStart >= 0, 'storyboard_prompts executor missing');
const storyboardBlock = batchSource.slice(storyboardStart, batchSource.indexOf("registerExecutor('storyboard_images'", storyboardStart));
assert.ok(storyboardBlock.includes("projectWorldContextForStage('storyboard_sketch_prompt'"));
assert.ok(storyboardBlock.includes('formatWorldContextForPrompt(worldContext)'));
assert.ok(storyboardBlock.includes('分镜稿参考的世界观事实与软默认'));

const auditSource = readFileSync(new URL('../lib/video-prompt-audit.ts', import.meta.url), 'utf8');
assert.ok(auditSource.includes("projectWorldContextForStage('video_prompt'"));
assert.ok(auditSource.includes('worldContext: projectWorldContextForStage'));

console.log('[test-world-injection-contract] all assertions passed');
