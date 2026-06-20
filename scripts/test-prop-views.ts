import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas } from '@napi-rs/canvas';

const tmp = mkdtempSync(join(tmpdir(), 'origin-prop-views-'));
process.env.ORIGIN_DATA_DIR = tmp;
process.env.DB_PATH = join(tmp, 'test.sqlite');

let propViews: typeof import('../lib/prop-views');
let getDb: typeof import('../lib/db').getDb;

function seededViews(): import('../lib/prop-views').PropViewsMeta {
  return {
    schema: propViews.PROP_VIEW_SCHEMA,
    sourceImageId: '00000000-0000-4000-8000-000000000001',
    sourceImageUrl: '/api/images/file/00000000-0000-4000-8000-000000000001',
    sheetUrl: '/api/images/file/00000000-0000-4000-8000-000000000001',
    version: 3,
    generatedAt: '2026-06-20T00:00:00.000Z',
    slots: {},
    quality: { slots: {}, roles: {} },
    front: {
      role: 'front',
      imageUrl: '/api/images/file/00000000-0000-4000-8000-000000000101',
      rawUrl: '/api/images/file/00000000-0000-4000-8000-000000000101',
    },
    hero: {
      role: 'hero',
      imageUrl: '/api/images/file/00000000-0000-4000-8000-000000000102',
    },
    back: {
      role: 'back',
      imageUrl: '/api/images/file/00000000-0000-4000-8000-000000000103',
    },
    top: {
      role: 'top',
      imageUrl: '/api/images/file/00000000-0000-4000-8000-000000000104',
    },
    side: {
      role: 'side',
      slot: 'side_right',
      imageUrl: '/api/images/file/00000000-0000-4000-8000-000000000105',
    },
  };
}

function testPureViewContracts() {
  assert.equal(propViews.normalizePropDimensionality('', { propType: '文件纸张' }), 'flat');
  assert.equal(propViews.normalizePropDimensionality('', { propType: '青铜钥匙' }), 'volumetric');
  assert.equal(propViews.propViewStaleKey(7), 'asset_img_prop_7');

  const written = propViews.applyPropViewWrite(
    { name: '铜钥匙', imageUrl: 'old-main', viewsVersion: 2, views: seededViews() },
    {
      splitResult: { ok: true, views: seededViews(), viewImageIds: ['00000000-0000-4000-8000-000000000101'] },
      sourceImageUrl: '/api/images/file/00000000-0000-4000-8000-000000000001',
      imagePrompt: 'six view prop sheet',
    },
  );
  assert.equal(written.imageUrl, '/api/images/file/00000000-0000-4000-8000-000000000101');
  assert.equal(written.rawUrl, '/api/images/file/00000000-0000-4000-8000-000000000101');
  assert.equal(written.views.sheetUrl, '/api/images/file/00000000-0000-4000-8000-000000000001');
  assert.equal(written.assetId, '00000000-0000-4000-8000-000000000101');
  assert.equal(written.viewHistory[0].version, 2);

  assert.equal(
    propViews.resolvePropImageUrl({ imageUrl: 'legacy-main' }, { strategy: 'videoManifest', viewRole: 'top', gate: true }),
    'legacy-main',
    'legacy and flat props must fall back to top-level imageUrl',
  );
  assert.equal(
    propViews.resolvePropImageUrl(written, { strategy: 'videoManifest', viewRole: 'top', gate: true }),
    '/api/images/file/00000000-0000-4000-8000-000000000104',
  );
  assert.equal(
    propViews.resolvePropImageUrl({
      imageUrl: '/api/images/file/00000000-0000-4000-8000-000000000001',
      rawUrl: '/api/images/file/00000000-0000-4000-8000-000000000001',
      reference: {
        status: 'ready',
        currentUrl: '/api/images/file/00000000-0000-4000-8000-000000000001',
      },
      views: seededViews(),
    }, { strategy: 'videoManifest', gate: true }),
    '/api/images/file/00000000-0000-4000-8000-000000000101',
    'views.front must win over a stale top-level sheet URL',
  );
  assert.equal(propViews.pickPropView(written, { angle: '俯拍展示桌面' }).role, 'top');
  assert.equal(propViews.pickPropView(written, { description: '镜头看到铜钥匙背面纹理' }).role, 'back');
  assert.equal(propViews.pickPropView(written, { description: '人物背面经过桌子' }).role, 'front');
}

function drawObject(ctx: any, cellW: number, cellH: number, col: number, row: number, opts: { edge?: boolean; color?: string } = {}) {
  const originX = col * cellW;
  const originY = row * cellH;
  ctx.fillStyle = opts.color || '#333333';
  if (opts.edge) {
    ctx.fillRect(originX, originY + Math.round(cellH * 0.25), Math.round(cellW * 0.52), Math.round(cellH * 0.5));
    return;
  }
  ctx.fillRect(
    originX + Math.round(cellW * 0.28),
    originY + Math.round(cellH * 0.24),
    Math.round(cellW * 0.44),
    Math.round(cellH * 0.52),
  );
  ctx.fillStyle = '#666666';
  ctx.fillRect(
    originX + Math.round(cellW * 0.38),
    originY + Math.round(cellH * 0.36),
    Math.round(cellW * 0.24),
    Math.round(cellH * 0.2),
  );
}

async function testSheetSplit() {
  const db = getDb();
  const ownerId = 101;
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash) VALUES (?, 'prop-view-user', 'Prop View User', 'x')`).run(ownerId);

  const sourceId = '00000000-0000-4000-8000-000000000201';
  const ownerDir = join(tmp, 'images', String(ownerId));
  mkdirSync(ownerDir, { recursive: true });
  const canvas = createCanvas(1536, 1024);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1536, 1024);
  const cellW = 512;
  const cellH = 512;
  drawObject(ctx, cellW, cellH, 0, 0, { color: '#5a3921' });
  drawObject(ctx, cellW, cellH, 1, 0, { color: '#6b4528' });
  drawObject(ctx, cellW, cellH, 2, 0, { color: '#4a301f' });
  drawObject(ctx, cellW, cellH, 0, 1, { edge: true, color: '#664422' });
  drawObject(ctx, cellW, cellH, 1, 1, { color: '#7a4d29' });
  drawObject(ctx, cellW, cellH, 2, 1, { color: '#79512f' });
  const buffer = canvas.toBuffer('image/png') as Buffer;
  writeFileSync(join(ownerDir, `${sourceId}.png`), buffer);
  db.prepare(
    `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
     VALUES (?, ?, 'project-1', 'prop', 'props[0]', ?, 'image/png', ?, 1536, 1024, 'source sheet', 'prop-view-sheet')`,
  ).run(sourceId, ownerId, `${sourceId}.png`, buffer.length);

  const result = await propViews.splitPropViews({
    user: { id: ownerId } as any,
    projectId: 'project-1',
    assetRef: 'props[0]',
    sourceImageUrl: `/api/images/file/${sourceId}`,
    prompt: 'six view bronze key',
    version: 2,
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  if (!result.ok) return;
  assert.equal(result.views.version, 2);
  assert.equal(result.views.front?.role, 'front');
  assert.equal(result.views.side?.slot, 'side_right', 'edge-touching side_left should be degraded in favor of side_right');
  assert.equal(result.views.quality.slots.side_left?.usable, false);
  assert.equal(result.views.quality.slots.side_left?.reason, 'subject-touches-cell-edge');
  assert.equal(result.views.front?.imageUrl?.includes('/api/images/file/'), true);
  assert.equal(result.views.sourceImageUrl, `/api/images/file/${sourceId}`);
  const writtenRows = db.prepare(`SELECT COUNT(*) AS c FROM images WHERE owner_id=? AND project_id='project-1' AND style='prop-view'`).get(ownerId) as any;
  assert.equal(writtenRows.c, 5, 'five usable slots should be written; edge-touching slot is not persisted');
}

async function main() {
  propViews = await import('../lib/prop-views');
  ({ getDb } = await import('../lib/db'));
  testPureViewContracts();
  await testSheetSplit();
  console.log('[test-prop-views] all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
