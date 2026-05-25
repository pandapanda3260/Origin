import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem() { return ''; },
  removeItem() {},
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
};

const { _applyServerStaleFlagsToProject, deriveAssetCardState, syncAssetsProject } = await import('../public/modules/assets.js');

// The asset page no longer auto-syncs style-driven asset stale badges.
// This helper still backs managed-prefix mirroring for downstream stale families.
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
  assert.equal(state.statusMessage, '本次生成结果不可用，请重新生成');
}

{
  const state = deriveAssetCardState({
    imageUrl: '/fallback.png',
    reference: {
      status: 'degraded',
      currentUrl: '/fallback.png',
      lastKnownGoodUrl: '/fallback.png',
    },
  });
  assert.equal(state.status, 'degraded');
  assert.equal(state.mainImageUrl, '/fallback.png');
  assert.equal(state.failedAttemptUrl, '');
  assert.equal(state.statusLabel, '可用（比例兜底）');
  assert.match(state.statusMessage, /比例兜底/);
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
  assert.equal(state.statusMessage, '本次生成结果不可用，请重新生成');
}

{
  syncAssetsProject({
    characters: [{ imageUrl: '/legacy-human.png', panels: { schema: 'human-character-sheet-v1' } }],
    consistency: { characters: [] },
  });
  const state = deriveAssetCardState({
    name: '活螃蟹',
    entityType: 'non-human',
    reference: {
      status: 'failed',
      lastAttemptUrl: '/crab-attempt.png',
      lastError: { reason: 'character_panel_split_failed', message: 'not enough usable panels' },
    },
  }, 0);
  assert.equal(state.status, 'failed');
  assert.equal(state.mainImageUrl, '', 'non-human character must not use legacy human top-level fallback');
  assert.equal(state.previewImageUrl, '/crab-attempt.png');
}

{
  syncAssetsProject({
    characters: [{ imageUrl: '/legacy-human.png', panels: { schema: 'human-character-sheet-v1' } }],
    consistency: { characters: [] },
  });
  const state = deriveAssetCardState({ entityType: 'human' }, 0);
  assert.equal(state.mainImageUrl, '/legacy-human.png', 'human character may still use compatible legacy fallback');
}

{
  syncAssetsProject(null);
  const state = deriveAssetCardState({
    entityType: 'non-human',
    imageUrl: '/wrong-human.png',
    panels: { schema: 'human-character-sheet-v1' },
    reference: { status: 'ready', currentUrl: '/wrong-human.png' },
  }, 0);
  assert.equal(state.status, 'missing');
  assert.equal(state.mainImageUrl, '', 'non-human asset must not render its own mismatched human sheet');
}

console.log('[test-assets-stale-flags] all assertions passed');
