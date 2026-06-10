/**
 * 部—集逻辑契约锁（docs/series-episode-continue-plan.md）
 *
 * 2026-06-10 改版：续写下一集 = 新建独立任务。本测试锁两件事：
 * 1) 旧的项目内 AI 续写链路（/api/script/workflow/episode-create）已彻底摘除，防回归；
 * 2) episodes[] 镜像机制（老多集项目兼容读）与新弹窗的关键契约仍在。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EPISODE_FIELDS, createEmptyEpisode, mirrorEpisodeFields } from '../public/modules/episode_fields.js';

// —— 镜像机制兼容读保留 ——
const expectedFields = [
  'idea',
  'script',
  'scriptDraft',
  'scriptTargetDurationSec',
  'scriptApproved',
  'scriptReviewState',
  'assets',
  'assetsApproved',
  'shots',
  'shotsApproved',
  'storyboards',
  'imagesApproved',
  'videoPrompts',
  'videoPromptsApproved',
  'narrations',
  'emotionSegments',
  'scriptTimeline',
  'currentStep',
];
assert.deepEqual([...EPISODE_FIELDS], expectedFields);

const episode = createEmptyEpisode({ id: 'ep-contract', title: '第 2 集', scriptTargetDurationSec: 60 });
assert.equal(episode.id, 'ep-contract');
assert.equal(episode.title, '第 2 集');
assert.equal(episode.scriptTargetDurationSec, 60);
for (const field of EPISODE_FIELDS) {
  assert.ok(Object.prototype.hasOwnProperty.call(episode, field), `missing episode field ${field}`);
}

const mirrored = mirrorEpisodeFields({}, { ...episode, script: '新一集剧本', currentStep: 1 });
assert.equal(mirrored.script, '新一集剧本');
assert.equal(mirrored.currentStep, 1);
for (const field of EPISODE_FIELDS) {
  assert.ok(Object.prototype.hasOwnProperty.call(mirrored, field), `missing mirrored field ${field}`);
}

// —— AI 续写摘除锁 ——
const episodesSource = readFileSync(new URL('../public/modules/episodes.js', import.meta.url), 'utf8');
assert.ok(!episodesSource.includes('/api/script/workflow/episode-create'), 'AI 续写调用不应回归 episodes.js');
assert.ok(!episodesSource.includes('apiPostStream'), '旧流式续写调用应清除');
const routeDir = fileURLToPath(new URL('../app/api/script/workflow/episode-create', import.meta.url));
assert.ok(!existsSync(routeDir), 'episode-create 路由目录应已删除');

// —— 续写=新建任务 新契约 ——
assert.ok(episodesSource.includes('续写下一集'), '新弹窗标题');
assert.ok(episodesSource.includes('"/api/projects"'), '新建任务走 POST /api/projects');
assert.ok(episodesSource.includes('project_quota_exceeded'), '配额 409 处理');
assert.ok(episodesSource.includes('seriesId'), '部 id 字段');
assert.ok(episodesSource.includes('prevProjectId'), '前集链字段');
assert.ok(episodesSource.includes('snapshotWorldTemplate'), '世界观快照与风格页同款语义');

// —— main.js 契约 ——
const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
assert.match(mainSource, /\.\/modules\/episode_fields\.js\?v=\d+/);
assert.ok(!/var\s+EPISODE_FIELDS\s*=/.test(mainSource), 'EPISODE_FIELDS 单一来源');
assert.ok(mainSource.includes('finalizeCreatedProject'), '创建收尾统一函数（新建/续写共用）');
assert.ok(!mainSource.includes('_createNewEpisode'), '旧 AI 续写入口引用应清除');

// —— projects-db 白名单/摘要三字段锁 ——
const dbSource = readFileSync(new URL('../lib/projects-db.ts', import.meta.url), 'utf8');
for (const key of ['seriesId', 'episodeNumber', 'prevProjectId']) {
  assert.ok(dbSource.includes(`'${key}',`), `projects-db 创建白名单应含 ${key}`);
}

console.log('[test-episode-create-contract] all assertions passed');
