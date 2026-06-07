import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, type UserRow } from '../lib/db';
import { generateImage } from '../lib/image-gen';
import { deleteProjectForUser } from '../lib/projects-db';
import { dataPath } from '../lib/runtime-paths';
import { adoptAssetAsCurrent, attachAssetLibraryCurrentToProject, softDeleteAsset } from '../lib/asset-library';

async function main() {
  const db = getDb();
  const ownerId = 990003;
  const projectId = 'asset-dual-write-project';

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(ownerId, 'asset-library-test-user', 'Asset Library Test User', 'x');

  db.prepare('DELETE FROM assets WHERE owner_id = ?').run(ownerId);
  db.prepare('DELETE FROM asset_version_groups WHERE owner_id = ?').run(ownerId);
  db.prepare('DELETE FROM quota_usage WHERE owner_id = ?').run(ownerId);
  db.prepare('DELETE FROM images WHERE owner_id = ?').run(ownerId);
  db.prepare('DELETE FROM projects WHERE owner_id = ? AND id = ?').run(ownerId, projectId);

  db.prepare(
    `INSERT INTO projects (id, owner_id, title, data_json)
     VALUES (?, ?, ?, ?)`,
  ).run(projectId, ownerId, 'Asset Dual Write Project', JSON.stringify({
    storyboards: [{ shotUid: 'dual-shot-1' }],
    shots: [{ id: 'dual-shot-1', idx: 1 }],
  }));

  const user = db.prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id').get({ id: ownerId })!;
  const result = await generateImage(user, {
    prompt: 'simple smoke image',
    kind: 'storyboard',
    projectId,
    assetRef: 'storyboards[0]',
    size: '512x512',
    assetLibrary: {
      shotUid: 'dual-shot-1',
      stage: 'storyboard',
      makeCurrent: true,
    },
  });

  const imageRow = db.prepare<{ id: string }, any>('SELECT * FROM images WHERE id = @id').get({ id: result.id });
  assert.equal(imageRow?.id, result.id);
  assert.ok(existsSync(join(dataPath('images', String(ownerId)), imageRow.filename)), 'generated image file should exist');

  const assetRow = db.prepare<{ id: string }, any>('SELECT * FROM assets WHERE asset_id = @id').get({ id: result.id });
  assert.equal(assetRow?.stage, 'storyboard');
  assert.equal(assetRow?.shot_uid, 'dual-shot-1');
  assert.equal(assetRow?.project_relation_status, 'linked');
  assert.equal(assetRow?.shot_relation_status, 'linked');

  const group = db.prepare<{ id: string }, any>(
    'SELECT * FROM asset_version_groups WHERE version_group_id = @id',
  ).get({ id: assetRow.version_group_id });
  assert.equal(group?.current_asset_id, result.id);

  const rawProject = db.prepare<{ id: string }, any>('SELECT * FROM projects WHERE id = @id').get({ id: projectId });
  const projectForRead = {
    id: rawProject.id,
    ...JSON.parse(rawProject.data_json || '{}'),
  };
  const hydrated = attachAssetLibraryCurrentToProject(projectForRead, ownerId);
  assert.equal(hydrated.storyboards[0].imageUrl, `/api/images/file/${result.id}`);
  assert.equal(hydrated.storyboards[0].assetLibraryAssetId, result.id);

  const blockedDelete = softDeleteAsset({ ownerId, assetId: result.id });
  assert.equal(blockedDelete.ok, false);
  assert.equal(blockedDelete.error, 'asset_is_current');

  const clearDelete = softDeleteAsset({ ownerId, assetId: result.id, clearCurrentIfOnlyVersion: true });
  assert.equal(clearDelete.ok, true);
  const clearedGroup = db.prepare<{ id: string }, any>(
    'SELECT current_asset_id FROM asset_version_groups WHERE version_group_id = @id',
  ).get({ id: assetRow.version_group_id });
  assert.equal(clearedGroup.current_asset_id, null);

  const resurrected = adoptAssetAsCurrent(ownerId, result.id);
  assert.equal(resurrected.ok, true);
  const activeAgain = db.prepare<{ id: string }, any>('SELECT lifecycle_status FROM assets WHERE asset_id = @id').get({ id: result.id });
  assert.equal(activeAgain.lifecycle_status, 'active');

  const deleted = deleteProjectForUser(projectId, ownerId);
  assert.equal(deleted, true);

  const retainedImage = db.prepare<{ id: string }, any>('SELECT * FROM images WHERE id = @id').get({ id: result.id });
  assert.equal(retainedImage?.id, result.id, 'project delete must retain image metadata');
  assert.equal(retainedImage?.project_id, null, 'legacy image row should detach from deleted project');
  assert.ok(existsSync(join(dataPath('images', String(ownerId)), retainedImage.filename)), 'project delete must retain image file');

  const orphanedAsset = db.prepare<{ id: string }, any>('SELECT * FROM assets WHERE asset_id = @id').get({ id: result.id });
  assert.equal(orphanedAsset?.project_relation_status, 'orphaned_project');

  console.log(JSON.stringify({ ok: true, imageId: result.id, assetStage: assetRow.stage, projectDeleteRetained: true }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
