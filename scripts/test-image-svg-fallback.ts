import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'origin-svg-fallback-'));
  process.env.ORIGIN_DATA_DIR = join(dir, 'data');
  process.env.DB_PATH = join(dir, 'data', 'qd.sqlite');
  process.env.JWT_SECRET = 'origin-svg-fallback-jwt-secret-000000000000';
  process.env.ASSET_URL_SECRET = 'origin-svg-fallback-asset-secret-000000000';

  try {
    const [{ getDb }, { dataPath }, { buildSignedImageUrl }, route] = await Promise.all([
      import('../lib/db'),
      import('../lib/runtime-paths'),
      import('../lib/signed-asset-url'),
      import('../app/api/images/file/[id]/route'),
    ]);

    const ownerId = 1;
    const imageId = 'svg-fallback-smoke';
    const filename = 'misclassified-svg.png';
    const bytes = Buffer.from('<?xml version="1.0"?><svg><nonsense>', 'utf8');
    await mkdir(dataPath('images', String(ownerId)), { recursive: true });
    await writeFile(dataPath('images', String(ownerId), filename), bytes);

    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, password_hash, email_verified)
       VALUES (@id, @username, @displayName, @passwordHash, 1)`
    ).run({
      id: ownerId,
      username: 'svg-fallback-user',
      displayName: 'SVG Fallback User',
      passwordHash: 'unused',
    });
    db.prepare(
      `INSERT INTO images (id, owner_id, project_id, kind, filename, mime, size_bytes, width, height, prompt, style)
       VALUES (@id, @ownerId, @projectId, @kind, @filename, @mime, @sizeBytes, @width, @height, @prompt, @style)`
    ).run({
      id: imageId,
      ownerId,
      projectId: null,
      kind: 'other',
      filename,
      mime: 'image/png',
      sizeBytes: bytes.length,
      width: 512,
      height: 512,
      prompt: '',
      style: '',
    });

    const signed = buildSignedImageUrl(imageId, ownerId, 300).url;
    const url = `http://localhost${signed}&w=200`;
    const response = await route.GET(new NextRequest(url), { params: { id: imageId } });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status === 422) throw new Error('bad SVG thumbnail request returned 422');
    if (response.status !== 200) throw new Error(`bad SVG thumbnail request returned ${response.status}`);
    if (!body.equals(bytes)) throw new Error('bad SVG thumbnail request did not fall back to original bytes');
    console.log('[test-image-svg-fallback] ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[test-image-svg-fallback] failed:', error);
  process.exit(1);
});
