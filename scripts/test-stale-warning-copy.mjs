import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem() { return ''; },
  removeItem() {},
  setItem() {},
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
};

const { _assetStaleBannerTextForProject } = await import('../public/modules/assets.js');
const { _shotPlanChangeSubject } = await import('../public/modules/shots.js');
const { _vpStaleNoticeTextForStoryboard } = await import('../public/modules/videoPrompts.js');

assert.equal(
  _assetStaleBannerTextForProject({
    scriptReviewState: 'approved',
    styleBibleGeneratedAt: '2026-06-09T17:02:18.320Z',
    _staleFlags: { assets: true },
  }),
  '风格/世界观设定已更新，资产可能需要重新分析以保持一致性',
  'asset stale copy should infer style/world cause for approved legacy projects',
);

assert.equal(
  _assetStaleBannerTextForProject({
    scriptReviewState: 'modified',
    styleBibleGeneratedAt: '2026-06-09T17:02:18.320Z',
    _staleFlags: { assets: true },
  }),
  '剧本已修改，资产可能需要重新分析以保持一致性',
  'script modified state still takes precedence',
);

assert.equal(
  _shotPlanChangeSubject(['world_changed', 'assets_changed']),
  '世界观、资产库',
  'shot-plan stale reasons should include world_changed as a user-facing label',
);

assert.equal(
  _vpStaleNoticeTextForStoryboard(
    { staleSource: 'shot_plan', staleSourceReasons: ['world_changed', 'assets_changed'] },
    2,
    { _staleFlags: { video_prompt_2: true } },
  ),
  '世界观、资产库已变化，当前正式视频提示词可能需要重新生成或重新确认。',
  'video-prompt stale notice should use propagated storyboard reasons',
);

assert.equal(
  _vpStaleNoticeTextForStoryboard(
    { staleSource: 'shot_plan' },
    2,
    { _staleFlags: { video_prompt_2: true }, shotPlanStaleReasons: ['emotion_changed'] },
  ),
  '情绪节奏已变化，当前正式视频提示词可能需要重新生成或重新确认。',
  'video-prompt stale notice should fall back to project shot-plan reasons',
);

console.log('[test-stale-warning-copy] all assertions passed');
