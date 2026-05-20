import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem() { return ''; },
  removeItem() {},
};
globalThis.window = {};
globalThis.document = {};

const { _applyServerStaleFlagsToProject, deriveAssetCardState } = await import('../public/modules/assets.js');

{
  const project = {
    _staleFlags: {
      asset_img_char_0: true,
      asset_img_scene_0: true,
      shot_prompt_0: true,
    },
  };
  const changed = _applyServerStaleFlagsToProject(project, 'asset_img_', {});
  assert.equal(changed, true, 'server-empty asset style flags should clear local asset stale flags');
  assert.equal(project._staleFlags.asset_img_char_0, undefined);
  assert.equal(project._staleFlags.asset_img_scene_0, undefined);
  assert.equal(project._staleFlags.shot_prompt_0, true, 'non-matching prefixes must be preserved');
}

{
  const project = {
    _staleFlags: {
      asset_img_char_0: true,
    },
  };
  const changed = _applyServerStaleFlagsToProject(project, 'asset_img_', {
    asset_img_char_1: true,
    asset_img_prop_0: false,
    shot_prompt_0: true,
  });
  assert.equal(changed, true, 'server asset flags should replace local asset mirror');
  assert.equal(project._staleFlags.asset_img_char_0, undefined);
  assert.equal(project._staleFlags.asset_img_char_1, true);
  assert.equal(project._staleFlags.asset_img_prop_0, undefined, 'false server flags should not be stored');
  assert.equal(project._staleFlags.shot_prompt_0, undefined, 'non-matching server flags should not be applied by this helper call');
}

{
  const project = {
    _staleFlags: {
      asset_img_char_0: true,
      storyboard_0: true,
      tail_frame_0: true,
      video_prompt_0: true,
    },
  };
  const changed = _applyServerStaleFlagsToProject(project, ['asset_img_', 'storyboard_', 'tail_frame_'], {
    storyboard_1: true,
    tail_frame_0: true,
  });
  assert.equal(changed, true);
  assert.equal(project._staleFlags.asset_img_char_0, undefined);
  assert.equal(project._staleFlags.storyboard_0, undefined);
  assert.equal(project._staleFlags.storyboard_1, true);
  assert.equal(project._staleFlags.tail_frame_0, true);
  assert.equal(project._staleFlags.video_prompt_0, true, 'unmanaged stale families should be left alone');
}

{
  const project = { _staleFlags: { asset_img_char_0: true } };
  const changed = _applyServerStaleFlagsToProject(project, 'asset_img_', { asset_img_char_0: true });
  assert.equal(changed, false, 'matching mirror should be a no-op');
  assert.equal(project._staleFlags.asset_img_char_0, true);
}

{
  const state = deriveAssetCardState({
    imageUrl: '/old.png',
    reference: {
      status: 'failed',
      lastAttemptUrl: '/failed.png',
      lastError: {
        reason: 'character_panel_split_failed',
        cropMethod: 'percent-fallback',
        unusablePanels: ['front'],
      },
    },
  });
  assert.equal(state.status, 'failed');
  assert.equal(state.mainImageUrl, '/old.png', 'failed attempt should not replace main reference image');
  assert.equal(state.failedAttemptUrl, '/failed.png');
  assert.equal(state.statusLabel, '生成失败');
  assert.match(state.statusMessage, /背景不够纯白|切片/);
}

{
  const state = deriveAssetCardState({
    reference: {
      status: 'failed',
      lastAttemptUrl: '/failed.png',
      lastError: { reason: 'character_panel_split_failed', message: 'not enough usable panels' },
    },
  });
  assert.equal(state.status, 'failed');
  assert.equal(state.mainImageUrl, '');
  assert.equal(state.failedAttemptUrl, '/failed.png');
  assert.match(state.statusMessage, /not enough usable panels/);
}

console.log('[test-assets-stale-flags] all assertions passed');
