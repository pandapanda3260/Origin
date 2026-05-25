import assert from 'node:assert/strict';
import { getDb } from '../lib/db';
import { backfillAssetLibrary } from './backfill-asset-library';
import { markColdAssets } from '../lib/asset-library';

const db = getDb();
const ownerId = 990002;
const projectId = 'asset-backfill-project';

db.prepare(
  `INSERT INTO users (id, username, display_name, password_hash)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(id) DO NOTHING`,
).run(ownerId, 'asset-backfill-user', 'asset-backfill-user', 'x');

db.prepare('DELETE FROM assets WHERE owner_id = ?').run(ownerId);
db.prepare('DELETE FROM asset_version_groups WHERE owner_id = ?').run(ownerId);
db.prepare('DELETE FROM quota_usage WHERE owner_id = ?').run(ownerId);
db.prepare('DELETE FROM images WHERE owner_id = ?').run(ownerId);
db.prepare('DELETE FROM video_tasks WHERE owner_id = ?').run(ownerId);
db.prepare('DELETE FROM uploads WHERE owner_id = ?').run(ownerId);
db.prepare('DELETE FROM exports WHERE owner_id = ?').run(ownerId);
db.prepare('DELETE FROM projects WHERE owner_id = ? AND id = ?').run(ownerId, projectId);

const projectData = {
  storyboards: [
    { shotUid: 'stable-shot-1', imageUrl: '/api/images/file/backfill-img-2' },
  ],
  shots: [
    { id: 'stable-shot-1', idx: 1 },
  ],
};

db.prepare(
  `INSERT INTO projects (id, owner_id, title, data_json)
   VALUES (?, ?, ?, ?)`,
).run(projectId, ownerId, 'Asset Backfill Project', JSON.stringify(projectData));

db.prepare(
  `INSERT INTO images
    (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style, created_at)
   VALUES
    (?, ?, ?, 'storyboard', 'storyboards[0]', ?, 'image/png', ?, 100, 100, ?, 'pencil', ?)`,
).run('backfill-img-1', ownerId, projectId, 'backfill-img-1.png', 10, 'prompt 1', '2026-01-01T00:00:00.000Z');

db.prepare(
  `INSERT INTO images
    (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style, created_at)
   VALUES
    (?, ?, ?, 'storyboard', 'storyboards[0]', ?, 'image/png', ?, 100, 100, ?, 'pencil', ?)`,
).run('backfill-img-2', ownerId, projectId, 'backfill-img-2.png', 20, 'prompt 2', '2026-01-01T00:01:00.000Z');

db.prepare(
  `INSERT INTO video_tasks
    (id, owner_id, project_id, group_idx, prompt, provider, status, progress, filename, duration_sec, created_at)
   VALUES
    (?, ?, ?, 0, 'video prompt', 'fake', 'completed', 100, ?, 4, ?)`,
).run('backfill-video-1', ownerId, projectId, 'backfill-video-1.mp4', '2026-01-01T00:02:00.000Z');

db.prepare(
  `INSERT INTO uploads
    (id, owner_id, project_id, kind, filename, mime, size_bytes, created_at)
   VALUES
    (?, ?, ?, 'image', ?, 'image/png', 30, ?)`,
).run('backfill-upload-1', ownerId, projectId, 'backfill-upload-1.png', '2026-01-01T00:03:00.000Z');

db.prepare(
  `INSERT INTO exports
    (id, owner_id, project_id, status, progress, filename, edl_json, duration_sec, created_at)
   VALUES
    (?, ?, ?, 'completed', 100, ?, '{}', 8, ?)`,
).run('backfill-export-1', ownerId, projectId, 'backfill-export-1.mp4', '2026-01-01T00:04:00.000Z');

const first = backfillAssetLibrary({ ownerId });
const second = backfillAssetLibrary({ ownerId });

assert.deepEqual(first, {
  dryRun: false,
  images: 2,
  videos: 1,
  uploads: 1,
  exports: 1,
  skipped: 0,
});
assert.deepEqual(second, first);

const assetCount = db.prepare<{ ownerId: number }, { c: number }>(
  'SELECT COUNT(*) AS c FROM assets WHERE owner_id = @ownerId',
).get({ ownerId })?.c;
assert.equal(assetCount, 5, 'backfill should be idempotent and not duplicate assets');

const storyboardGroup = db.prepare<{ ownerId: number; projectId: string }, any>(
  `SELECT vg.version_group_id, vg.current_asset_id, COUNT(a.asset_id) AS versions
     FROM asset_version_groups vg
     JOIN assets a ON a.version_group_id = vg.version_group_id
    WHERE vg.owner_id = @ownerId
      AND vg.project_id = @projectId
      AND vg.shot_uid = 'stable-shot-1'
      AND vg.stage = 'storyboard'
    GROUP BY vg.version_group_id, vg.current_asset_id`,
).get({ ownerId, projectId });

assert.equal(storyboardGroup?.versions, 2, 'storyboard history should share one version group');
assert.equal(storyboardGroup?.current_asset_id, 'backfill-img-2', 'latest historical image should be current');

const quota = db.prepare<{ ownerId: number }, any>(
  'SELECT * FROM quota_usage WHERE owner_id = @ownerId',
).get({ ownerId });
assert.equal(quota.hot_image_count, 3);
assert.equal(quota.hot_video_count, 2);
assert.equal(quota.hot_total_bytes, 60);

db.prepare(
  `UPDATE assets
      SET accessed_at = '2025-01-01T00:00:00.000Z'
    WHERE owner_id = ?
      AND asset_id = 'backfill-upload-1'`,
).run(ownerId);
const cold = markColdAssets({ ownerId, inactiveDays: 30 });
assert.equal(cold.markedCold, 1);
const coldUpload = db.prepare<{ id: string }, any>('SELECT storage_tier FROM assets WHERE asset_id = @id').get({ id: 'backfill-upload-1' });
assert.equal(coldUpload.storage_tier, 'cold');
const quotaAfterCold = db.prepare<{ ownerId: number }, any>(
  'SELECT * FROM quota_usage WHERE owner_id = @ownerId',
).get({ ownerId });
assert.equal(quotaAfterCold.hot_image_count, 2);
assert.equal(quotaAfterCold.hot_total_bytes, 30);

console.log(JSON.stringify({ ok: true, first, assetCount, current: storyboardGroup.current_asset_id, quota: {
  hotImageCount: quotaAfterCold.hot_image_count,
  hotVideoCount: quotaAfterCold.hot_video_count,
  hotTotalBytes: quotaAfterCold.hot_total_bytes,
} }));
