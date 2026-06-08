import assert from 'node:assert/strict';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { getDb, type UserRow } from '../lib/db';
import { splitCharacterPanels, type CharacterEntityType } from '../lib/character-panels';
import { getDataDir } from '../lib/runtime-paths';

const db = getDb();
const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get() as UserRow | undefined;
if (!user) throw new Error('at least one local user is required for panel split regression');
const currentUser: UserRow = user;

const ownerDir = join(getDataDir(), 'images', String(currentUser.id));
mkdirSync(ownerDir, { recursive: true });

function drawHumanSheet() {
  const width = 1536;
  const height = 1024;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#334155';
  const panels = [
    { left: 0, right: Math.round(width * 0.4) - 9, cx: Math.round(width * 0.2), bodyW: 170, bodyH: 470 },
    { left: Math.round(width * 0.4) + 9, right: Math.round(width * 0.6) - 9, cx: Math.round(width * 0.5), bodyW: 70, bodyH: 720 },
    { left: Math.round(width * 0.6) + 9, right: Math.round(width * 0.8) - 9, cx: Math.round(width * 0.7), bodyW: 62, bodyH: 720 },
    { left: Math.round(width * 0.8) + 9, right: width, cx: Math.round(width * 0.9), bodyW: 78, bodyH: 720 },
  ];
  for (const panel of panels) {
    ctx.fillRect(panel.left, 150, panel.right - panel.left, 26);
    ctx.fillRect(panel.cx - panel.bodyW / 2, 230, panel.bodyW, panel.bodyH);
  }
  return canvas.toBuffer('image/png') as Buffer;
}

function drawNonHumanSheet() {
  const width = 1536;
  const height = 1024;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#1f2937';
  const thirds = [0, Math.round(width / 3), Math.round((width * 2) / 3), width];
  for (let i = 0; i < 3; i++) {
    const left = thirds[i] + (i === 0 ? 0 : 9);
    const right = thirds[i + 1] - (i === 2 ? 0 : 9);
    const cx = Math.round((left + right) / 2);
    ctx.fillRect(left, 160, right - left, 26);
    ctx.beginPath();
    ctx.ellipse(cx, 540, 160, 250, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toBuffer('image/png') as Buffer;
}

async function runCase(entityType: CharacterEntityType, buffer: Buffer) {
  const id = randomUUID();
  const filename = `${id}.png`;
  const fullPath = join(ownerDir, filename);
  writeFileSync(fullPath, buffer);
  db.prepare(
    `INSERT INTO images (id, owner_id, project_id, kind, asset_ref, filename, mime, size_bytes, width, height, prompt, style)
     VALUES (?, ?, ?, 'character', ?, ?, 'image/png', ?, 1536, 1024, ?, 'character-sheet-smoke')`,
  ).run(
    id,
    currentUser.id,
    '__style_panel_split_smoke__',
    `characters[0].${entityType}.sheet`,
    filename,
    buffer.length,
    'synthetic white-safe character sheet',
  );

  try {
    const result = await splitCharacterPanels({
      user: currentUser,
      projectId: '__style_panel_split_smoke__',
      assetRef: `characters[0].${entityType}`,
      sourceImageUrl: `/api/images/file/${id}`,
      entityType,
      prompt: 'synthetic panel split smoke',
      version: 1,
    });
    assert.equal(result.ok, true, `${entityType} panel split should pass`);
    if (!result.ok) return;
    assert.equal(result.panels.cropMethod, 'pixel-detect', `${entityType} should use pixel-detect`);
    assert.ok(result.panels.confidence >= 0.85, `${entityType} confidence should be >= 0.85`);
    const required = entityType === 'human' ? ['headshot', 'front', 'side', 'back'] : ['front', 'side', 'back'];
    const qualityMap: Record<string, { usable?: boolean } | undefined> = result.panels.quality as any;
    for (const name of required) {
      const quality: { usable?: boolean } | undefined = qualityMap[name];
      assert.equal(quality?.usable, true, `${entityType}.${name} should be usable`);
    }
    const panelRows = result.panelImageIds
      .map((panelId) => db.prepare('SELECT id, asset_ref, filename, width, height FROM images WHERE id = ?').get(panelId) as {
        id: string;
        asset_ref: string;
        filename: string;
        width: number;
        height: number;
      } | undefined)
      .filter((row): row is { id: string; asset_ref: string; filename: string; width: number; height: number } => Boolean(row));
    if (entityType === 'human') {
      const headshot = panelRows.find((row) => String(row.asset_ref || '').endsWith('.panels.headshot'));
      assert.ok(headshot, 'human headshot panel should be written to images table');
      assert.ok(headshot.height / headshot.width >= 1.15, `human headshot should keep a full face/shoulder crop, got ${headshot.width}x${headshot.height}`);
    }
    for (const meta of panelRows) {
      if (meta) {
        const panelPath = join(ownerDir, meta.filename);
        if (existsSync(panelPath)) unlinkSync(panelPath);
      }
      db.prepare('DELETE FROM images WHERE id = ?').run(meta.id);
    }
  } finally {
    db.prepare('DELETE FROM images WHERE id = ?').run(id);
    if (existsSync(fullPath)) unlinkSync(fullPath);
  }
}

async function main() {
  await runCase('human', drawHumanSheet());
  await runCase('non-human', drawNonHumanSheet());
  console.log('[test-character-panel-split-contract] all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
