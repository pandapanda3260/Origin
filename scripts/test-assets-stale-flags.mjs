import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // syncAssetsProject → _refreshSaveWorldTemplateButton 会查 DOM 按钮（查不到即早退），
  // node 环境下补一个返回 null 的 stub 即可。
  getElementById() { return null; },
};

function browserModuleImportUrl(entry) {
  const srcDir = fileURLToPath(new URL('../public/modules/', import.meta.url));
  const tmpDir = mkdtempSync(join(tmpdir(), 'origin-browser-modules-'));
  process.on('exit', () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.js')) continue;
    const src = readFileSync(join(srcDir, name), 'utf8')
      .replace(/(from\s+['"])\/modules\//g, '$1./')
      .replace(/(import\s*\(\s*['"])\/modules\//g, '$1./');
    writeFileSync(join(tmpDir, name), src);
  }

  return pathToFileURL(join(tmpDir, entry)).href;
}

const { _applyServerStaleFlagsToProject, _assetStaleBannerTextForProject, _markDownstreamStaleFallback, _reindexAssetImageStateAfterDeletes, deriveAssetCardState, syncAssetsProject } = await import(browserModuleImportUrl('assets.js'));

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
  const project = { _staleFlags: {}, assets: { scenes: [{ name: '大厅' }] } };
  syncAssetsProject(project);
  _markDownstreamStaleFallback('asset', { type: 'scene', idx: 0 });
  assert.equal(project._staleFlags.asset_img_scene_0, undefined, 'scene fallback should not use aggregate stale key');
  assert.equal(project._staleFlags.asset_img_scene_0_establishing, true);
  assert.equal(project._staleFlags.asset_img_scene_0_reverse, true);
  assert.equal(project._staleFlags.asset_img_scene_0_alt, true);
  assert.equal(project._staleFlags.asset_img_scene_0_topdown, true);
}

{
  const project = {
    _staleFlags: {
      asset_img_scene_0_establishing: true,
      asset_img_scene_1: true,
      asset_img_scene_2_topdown: true,
      asset_img_prop_0: true,
    },
  };
  syncAssetsProject(project);
  _reindexAssetImageStateAfterDeletes('scene', [0]);
  assert.equal(project._staleFlags.asset_img_scene_0_establishing, undefined, 'deleted scene view stale key should be removed');
  assert.equal(project._staleFlags.asset_img_scene_0, true, 'higher aggregate scene stale key should shift down');
  assert.equal(project._staleFlags.asset_img_scene_1_topdown, true, 'higher per-role scene stale key should shift down');
  assert.equal(project._staleFlags.asset_img_prop_0, true, 'other asset stale families should be preserved');
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
  assert.equal(
    _assetStaleBannerTextForProject({
      scriptReviewState: 'approved',
      _staleFlags: { assets: true },
      styleBibleGeneratedAt: '2026-06-09T17:02:18.320Z',
    }),
    '风格/世界观设定已更新，资产可能需要重新分析以保持一致性',
    'legacy asset stale flags should infer style/world cause when the script is approved and style bible exists',
  );
  assert.equal(
    _assetStaleBannerTextForProject({
      scriptReviewState: 'approved',
      _staleFlags: { assets: true },
    }),
    '上游内容已更新，资产可能需要重新分析以保持一致性',
    'unknown legacy asset stale flags should stay neutral rather than claim a script edit',
  );
  assert.equal(
    _assetStaleBannerTextForProject({
      scriptReviewState: 'approved',
      _staleFlags: { assets: true },
      _staleFlagReasons: { assets: 'style_bible_changed' },
    }),
    '风格/世界观设定已更新，资产可能需要重新分析以保持一致性',
  );
  assert.equal(
    _assetStaleBannerTextForProject({
      scriptReviewState: 'modified',
      _staleFlags: { assets: true },
    }),
    '剧本已修改，资产可能需要重新分析以保持一致性',
  );
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
