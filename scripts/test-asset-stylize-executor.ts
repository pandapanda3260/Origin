import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-asset-stylize-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');
process.env.ORIGIN_BATCH_INLINE_RUNNER = '1';
process.env.ORIGIN_ENV_FILES = join(tempDir, 'missing.env');
process.env.IMAGE_API_KEY = '';
process.env.IMAGE_SEEDREAM_API_KEY = '';
process.env.IMAGE_FALLBACK_API_KEY = '';
process.env.IMAGE_FALLBACK_SEEDREAM_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.VIDEO_API_KEY = '';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBatch(getBatchSnapshot: (id: string) => any, batchId: string) {
  for (let i = 0; i < 80; i += 1) {
    const snap = getBatchSnapshot(batchId);
    if (snap && !['queued', 'running'].includes(String(snap.status))) return snap;
    await sleep(50);
  }
  throw new Error(`asset_stylize batch did not settle: ${batchId}`);
}

async function main() {
  const { getDb } = await import('../lib/db');
  const { createProjectForUser, getProjectByIdForUser, patchProjectForUser } = await import('../lib/projects-db');
  const { generateImage } = await import('../lib/image-gen');
  const { createBatch, getBatchSnapshot } = await import('../lib/batches');
  await import('../lib/batch-executors');

  const db = getDb();
  const user = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get() as any;
  assert.ok(user?.id, 'seed user exists');

  db.prepare(
    `UPDATE user_credits
        SET subscription_credits = 100,
            topup_credits = 0,
            bonus_credits = 0,
            total_credits = 100
      WHERE user_id = ?`,
  ).run(user.id);

  const projectId = 'project-asset-stylize-executor';
  createProjectForUser(user.id, {
    id: projectId,
    title: 'Asset stylize executor smoke',
    idea: 'A character style transfer regression fixture.',
  });

  const source = await generateImage(user, {
    prompt: 'neutral studio character source image',
    size: '1024x1024',
    style: 'natural',
    quality: 'medium',
    kind: 'character',
    projectId,
    assetRef: 'characters[0].source',
  });
  assert.equal(source.mode, 'fake');
  assert.match(source.url, /^\/api\/images\/file\//);

  const character = {
    name: 'Lin',
    appearance: 'short black hair, calm expression',
    clothing: 'plain blue jacket',
    realPhotoUrl: source.url,
    rawUrl: source.url,
    imageUrl: source.url,
  };

  patchProjectForUser(projectId, user.id, () => ({
    script: 'Lin enters a quiet room and looks at the camera.',
    styleBible: {
      visualStyle: 'clean realistic production reference',
      colorPalette: 'blue and warm white',
    },
    assets: { characters: [character], scenes: [], props: [] },
    characters: [character],
  }));

  const run = createBatch({
    user,
    batchType: 'asset_stylize',
    projectId,
    targets: [{ type: 'char', idx: 0 }],
  });
  const snap = await waitForBatch(getBatchSnapshot, run.batchId);

  assert.equal(snap.status, 'completed');
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0].status, 'completed');

  const project = getProjectByIdForUser(projectId, user.id) as any;
  const styledAsset = project?.assets?.characters?.[0];
  const styledTopLevel = project?.characters?.[0];
  assert.match(styledAsset?.pencilUrl || '', /^\/api\/images\/file\//);
  assert.equal(styledAsset.skippedStylize, undefined);
  assert.equal(styledAsset._pencilFailed, undefined);
  assert.equal(styledTopLevel?.pencilUrl, styledAsset.pencilUrl);

  const taskRow = db
    .prepare('SELECT result_json FROM batch_tasks WHERE batch_id = ? ORDER BY seq LIMIT 1')
    .get(run.batchId) as any;
  const taskResult = JSON.parse(taskRow.result_json || '{}');
  assert.equal(taskResult.resultUrl, styledAsset.pencilUrl);
  assert.equal(taskResult.extra?.mode, 'fake');

  const audit = db
    .prepare(
      `SELECT metadata_json
         FROM image_generation_audits
        WHERE owner_id = ?
          AND project_id = ?
          AND asset_ref = 'characters[0].stylize'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(user.id, projectId) as any;
  assert.ok(audit, 'asset_stylize image audit exists');
  const auditMetadata = JSON.parse(audit.metadata_json || '{}');
  assert.equal(auditMetadata.source, 'asset_stylize');
  assert.equal(Object.prototype.hasOwnProperty.call(auditMetadata, 'sourceUrl'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(auditMetadata, 'referenceUrl'), false);
}

main()
  .finally(() => {
    rmSync(tempDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
