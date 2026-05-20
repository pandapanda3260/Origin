import assert from 'node:assert/strict';
import { buildAssetStyleLock } from '../lib/asset-style-lock';
import { getDb, type UserRow } from '../lib/db';
import { generateImageWithModerationRecovery } from '../lib/safe-image-gen';

const db = getDb();
const columns = db.prepare("PRAGMA table_info(image_generation_audits)").all() as Array<{ name: string }>;
assert.ok(columns.some((col) => col.name === 'metadata_json'), 'image_generation_audits.metadata_json must exist');

const user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get() as UserRow | undefined;
if (!user) throw new Error('at least one local user is required for audit persistence regression');
const currentUser: UserRow = user;

const styleBible = {
  visualStyle: '冷峻都市/霓虹雨夜/真人黑色电影/婚礼反差/荒诞悬疑',
  lighting: '高反差冷光',
  colorPalette: [{ name: 'ink', hex: '#101820' }],
  negativePrompt: 'plastic skin, CG look',
};
const lock = buildAssetStyleLock(styleBible, 'char');
async function main() {
  const result = await generateImageWithModerationRecovery(
    currentUser,
    {
      prompt: `Subject: audit metadata smoke character.\n\n${lock.prompt}`,
      size: '1536x1024',
      style: 'natural',
      kind: 'character',
      entityType: 'human',
      projectId: '__style_audit_smoke__',
      assetRef: 'characters[0]',
      styleLockApplied: lock.hasMeaningfulStyle,
      styleBackdropColor: lock.resolvedBackdropColor,
      imageAuditMetadata: {
        styleBibleSignature: lock.signature,
        styleBibleSignatureType: lock.signatureType,
        resolvedBackdropColor: lock.resolvedBackdropColor,
        styleLockVersion: lock.styleLockVersion,
      },
    },
    {
      generateImageImpl: async () => ({
        id: `style-audit-smoke-${Date.now()}`,
        url: '/api/images/file/style-audit-smoke',
        width: 1536,
        height: 1024,
        bytes: 1,
        mode: 'fake',
      }),
    },
  );

  const audit = db.prepare(
    `SELECT metadata_json, final_composed_prompt
     FROM image_generation_audits
     WHERE correlation_id = ?`,
  ).get(result.safetyAudit.correlationId) as { metadata_json: string; final_composed_prompt: string } | undefined;

  assert.ok(audit, 'audit row should be persisted for fake image generation');
  const metadata = JSON.parse(audit.metadata_json || '{}');
  assert.equal(metadata.styleBibleSignature, lock.signature);
  assert.equal(metadata.styleBibleSignatureType, 'char');
  assert.equal(metadata.resolvedBackdropColor, '#FFFFFF');
  assert.equal(metadata.styleLockVersion, lock.styleLockVersion);
  assert.ok(audit.final_composed_prompt.includes('PROJECT CHARACTER STYLE LOCK'));
  assert.ok(audit.final_composed_prompt.includes('Background: PURE WHITE (#FFFFFF) seamless reference-sheet backdrop'));
  assert.ok(audit.final_composed_prompt.includes('NO readable hex codes or color names rendered as text INSIDE THE IMAGE'));
  assert.ok(audit.final_composed_prompt.includes('Lighting hint'));
  assert.ok(!audit.final_composed_prompt.includes('resolved color #F4F6F8'));
  assert.ok(!audit.final_composed_prompt.includes('Reference-sheet backdrop color:'));
  assert.ok(!audit.final_composed_prompt.includes('Project color palette:'));
  assert.equal((audit.final_composed_prompt.match(/Background:/g) || []).length, 1);

  db.prepare('DELETE FROM image_generation_audits WHERE correlation_id = ?').run(result.safetyAudit.correlationId);

  console.log('[test-image-audit-metadata] all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
