import assert from 'node:assert/strict';
import {
  buildVideoPromptBackupBackfillPatch,
  buildVideoPromptSnapshot,
  computeVideoPromptSourceHash,
  computeVideoPromptSourceSnapshot,
  currentDisplayVideoPrompt,
  videoPromptDraftFingerprint,
} from '../lib/video-prompt-lifecycle';

function fixtureProject(): any {
  return {
    id: 'proj_test',
    styleBible: { visualStyle: '电影感', castingProfile: { ethnicityType: 'han_chinese' } },
    assets: {
      characters: [{ id: 'char_1', name: '老板', appearance: '黑西装', imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000001?sig=abc' }],
      scenes: [{ id: 'scene_1', name: '办公室', imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000002?sig=abc' }],
      props: [{ id: 'prop_1', name: '合同', imageUrl: '/api/images/file/00000000-0000-0000-0000-000000000003?sig=abc' }],
	    },
	    planMeta: { version: 4, shotCount: 1, plannedDurationSec: 5 },
	    shots: [{
	      idx: 1,
	      shotType: '中景',
	      angle: '平视',
	      lens: '标准50',
	      focus: '中等景深',
	      light: '侧光·柔光·中性·低反差',
	      composition: '三分法',
	      camera: '缓慢推进',
      visual: '老板站在办公室里看合同',
      dialogue: '老板：明天翻倍。',
      durationSec: 5,
      characters: ['老板'],
      location: '办公室',
    }],
    storyboards: [{
      idx: 0,
      shotIdx: 1,
      shotIndices: [0],
      videoPrompt: '老板站在办公室里，镜头缓慢推进。',
      videoPromptSourceHash: 'old_hash',
      videoPromptUpdatedAt: '2026-05-27T00:00:00.000Z',
      frames: {
        first: {
          url: '/api/images/file/00000000-0000-0000-0000-000000000010?sig=abc',
          sourceHash: 'first_hash',
          prompt: '首帧提示词',
        },
      },
    }],
  };
}

const projectA = fixtureProject();
const hashA = computeVideoPromptSourceHash({ project: projectA, groupIdx: 0, ownerId: 1 });
const projectB = fixtureProject();
projectB.assets.characters[0].imageUrl = '/api/images/file/00000000-0000-0000-0000-000000000001?sig=different';
const hashB = computeVideoPromptSourceHash({ project: projectB, groupIdx: 0, ownerId: 1 });
assert.equal(typeof hashA, 'string', 'source hash should exist');
assert.equal(hashA!.length, 64, 'source hash should be sha256');
assert.equal(hashA, hashB, 'signed URL query params should not affect source hash');

const projectC = fixtureProject();
projectC.shots[0].dialogue = '老板：目标翻三倍。';
const hashC = computeVideoPromptSourceHash({ project: projectC, groupIdx: 0, ownerId: 1 });
assert.notEqual(hashA, hashC, 'shot dialogue change should affect source hash');

const projectD = fixtureProject();
projectD.shots[0].angle = '俯拍';
const hashD = computeVideoPromptSourceHash({ project: projectD, groupIdx: 0, ownerId: 1 });
assert.notEqual(hashA, hashD, 'shot angle change should affect source hash');

const projectE = fixtureProject();
projectE.planMeta.plannedDurationSec = 6;
const hashE = computeVideoPromptSourceHash({ project: projectE, groupIdx: 0, ownerId: 1 });
assert.notEqual(hashA, hashE, 'top-level planMeta change should affect source hash');

const projectF = fixtureProject();
const sketchOnlySbF = projectF.storyboards[0] as any;
sketchOnlySbF.frames = {};
sketchOnlySbF.url = '/api/images/file/00000000-0000-0000-0000-000000000020?sig=abc';
sketchOnlySbF.imageUrl = sketchOnlySbF.url;
sketchOnlySbF.rawUrl = sketchOnlySbF.url;
const sketchOnlySnapshot = computeVideoPromptSourceSnapshot({ project: projectF, groupIdx: 0, ownerId: 1 });
assert.equal(sketchOnlySnapshot.firstFrame.url, '', 'generic storyboard image must not enter firstFrame.url');
assert.equal(
  sketchOnlySnapshot.referenceManifest.some((ref: any) => ref.role === 'first_frame'),
  false,
  'generic storyboard image must not enter reference manifest as first_frame',
);
const projectG = fixtureProject();
const sketchOnlySbG = projectG.storyboards[0] as any;
sketchOnlySbG.frames = {};
sketchOnlySbG.url = '/api/images/file/00000000-0000-0000-0000-000000000021?sig=other';
sketchOnlySbG.imageUrl = sketchOnlySbG.url;
sketchOnlySbG.rawUrl = sketchOnlySbG.url;
assert.equal(
  computeVideoPromptSourceHash({ project: projectF, groupIdx: 0, ownerId: 1 }),
  computeVideoPromptSourceHash({ project: projectG, groupIdx: 0, ownerId: 1 }),
  'generic storyboard image URL changes should not affect video prompt source hash',
);

assert.equal(
  currentDisplayVideoPrompt({
    videoPrompt: '正式',
    videoPromptEditDraft: { content: '草稿' },
  }),
  '草稿',
  'draft should be display source first',
);
assert.equal(
  currentDisplayVideoPrompt({
    videoPrompt: '正式',
    videoPromptEditDraft: { content: '' },
  }),
  '',
  'empty draft should still be the display source while the user is editing',
);

const fp1 = videoPromptDraftFingerprint(hashA, '草稿内容');
const fp2 = videoPromptDraftFingerprint(hashA, { content: '草稿内容' });
const fp3 = videoPromptDraftFingerprint(hashC, '草稿内容');
assert.equal(fp1, fp2, 'string and object draft fingerprints should match');
assert.notEqual(fp1, fp3, 'source hash is part of draft fingerprint');

const backupPatch = buildVideoPromptBackupBackfillPatch(fixtureProject());
assert.ok(backupPatch?.storyboards?.[0]?.videoPromptBackup, 'legacy backup patch should be created');
assert.equal(backupPatch!.storyboards[0].videoPromptBackup.legacyBackfilled, true, 'legacy backup should be marked');

const longPrompt = '长提示词'.repeat(1200);
const snapshot = buildVideoPromptSnapshot({
  content: longPrompt,
  sourceHash: hashA,
  projectId: 'proj_test',
  groupIdx: 0,
  videoTaskId: 'video_task_1',
});
assert.equal(snapshot.content.length, longPrompt.length, 'snapshot must keep full prompt content');

console.log('[test-video-prompt-lifecycle] ok');
