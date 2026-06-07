import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EPISODE_FIELDS, createEmptyEpisode, mirrorEpisodeFields } from '../public/modules/episode_fields.js';

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

const episodesSource = readFileSync(new URL('../public/modules/episodes.js', import.meta.url), 'utf8');
assert.ok(episodesSource.includes('/api/script/workflow/episode-create'));
assert.ok(!episodesSource.includes('/api/script/workflow/continue'));
assert.ok(!episodesSource.includes('project.episodes.push(newEp)'));

const mainSource = readFileSync(new URL('../public/main.js', import.meta.url), 'utf8');
assert.ok(mainSource.includes('./modules/episode_fields.js?v=100'));
assert.ok(!/var\s+EPISODE_FIELDS\s*=/.test(mainSource));

console.log('[test-episode-create-contract] all assertions passed');
