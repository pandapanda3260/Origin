import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempDir = mkdtempSync(join(tmpdir(), 'origin-usage-billing-'));
process.env.ORIGIN_DATA_DIR = tempDir;
process.env.DB_PATH = join(tempDir, 'qd.sqlite');

async function main() {
  const { getDb } = await import('../lib/db');
  const { getBalance, grantCredits, InsufficientCreditsError } = await import('../lib/credits');
  const {
    assertCanStartPaidOperation,
    recordUsageEventAndSettleCharge,
    settleUsageCharge,
  } = await import('../lib/usage-billing');

  const db = getDb();
  const user = db.prepare(
    `INSERT INTO users (username, email, display_name, password_hash, email_verified)
     VALUES ('usage_billing_smoke', 'usage-billing@example.test', 'Usage Billing Smoke', 'test', 1)
     RETURNING id`,
  ).get() as { id: number };
  db.prepare(
    `INSERT INTO user_credits (user_id, total_credits, bonus_credits)
     VALUES (?, 1, 1)`,
  ).run(user.id);

  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM api_price_catalog').get() as any).c, 15);
  assertCanStartPaidOperation(user.id);

  const imageCharge = recordUsageEventAndSettleCharge({
    userId: user.id,
    usernameSnapshot: 'usage_billing_smoke',
    kind: 'image',
    reason: '测试图片生成',
    refId: 'image-smoke-1',
    chargeRefId: 'usage:image:image-smoke-1',
    provider: 'volcengine_seedream',
    model: 'doubao-seedream-4-5-251128',
    operationModule: 'image',
    operationFeature: 'asset_image',
    operationLabel: '资产图生成',
    consumptionType: 'image_count',
    quantity: 10,
    status: 'ok',
  });
  assert.equal(imageCharge.settled, true);
  assert.equal(imageCharge.alreadySettled, false);
  assert.equal(imageCharge.costCnyMicros, 2_500_000);
  assert.equal(imageCharge.points, 250);
  assert.equal(getBalance(user.id).totalCredits, -249);
  assert.equal(getBalance(user.id).overdraftCredits, 249);

  const duplicateImageCharge = recordUsageEventAndSettleCharge({
    userId: user.id,
    kind: 'image',
    reason: '测试图片生成重复回放',
    refId: 'image-smoke-1',
    chargeRefId: 'usage:image:image-smoke-1',
    provider: 'volcengine_seedream',
    model: 'doubao-seedream-4-5-251128',
    operationModule: 'image',
    operationFeature: 'asset_image',
    operationLabel: '资产图生成',
    consumptionType: 'image_count',
    quantity: 10,
    status: 'ok',
  });
  assert.equal(duplicateImageCharge.settled, true);
  assert.equal(duplicateImageCharge.alreadySettled, true);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE charge_ref_id = 'usage:image:image-smoke-1'").get() as any).c,
    1,
  );
  assert.equal(getBalance(user.id).totalCredits, -249);

  assert.throws(
    () => assertCanStartPaidOperation(user.id),
    (error: unknown) => error instanceof InsufficientCreditsError && (error as any).balance === -249,
  );

  grantCredits({
    userId: user.id,
    amount: 300,
    kind: 'gift',
    reason: '测试赠送还透支',
    bucket: 'bonus',
  });
  assert.equal(getBalance(user.id).overdraftCredits, 0);
  assert.equal(getBalance(user.id).totalCredits, 51);
  assert.equal(getBalance(user.id).bonusCredits, 51);

  db.prepare(
    `UPDATE user_credits
        SET subscription_credits = 0,
            topup_credits = 0,
            bonus_credits = 5000,
            overdraft_credits = 0,
            total_credits = 5000
      WHERE user_id = ?`,
  ).run(user.id);
  const textCharge = settleUsageCharge({
    userId: user.id,
    kind: 'text',
    reason: '测试文本 token',
    refId: 'text-smoke-1',
    chargeRefId: 'usage:text:text-smoke-1',
    provider: 'volcengine_chat',
    model: 'doubao-seed-2-0-pro-260215',
    consumptionType: 'text_token',
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cachedTokens: 100_000,
  });
  assert.equal(textCharge.settled, true);
  assert.equal(textCharge.costCnyMicros, 10_944_000);
  assert.equal(textCharge.points, 1095);
  const textLedger = db.prepare("SELECT * FROM credit_ledger WHERE charge_ref_id = 'usage:text:text-smoke-1'").get() as any;
  assert.equal(textLedger.amount, -1095);
  assert.equal(textLedger.input_tokens, 1_000_000);
  assert.equal(textLedger.output_tokens, 500_000);
  assert.equal(textLedger.cached_tokens, 100_000);
  assert.equal(textLedger.balance_after, 3905);

  const unpricedImage = recordUsageEventAndSettleCharge({
    userId: user.id,
    kind: 'image',
    reason: '测试 gpt-image-2 未验证用量',
    refId: 'image-smoke-unpriced',
    chargeRefId: 'usage:image:image-smoke-unpriced',
    provider: 'zerail_images',
    model: 'gpt-image-2',
    operationModule: 'image',
    operationFeature: 'asset_image',
    operationLabel: '资产图生成',
    consumptionType: 'image_count',
    quantity: 1,
    status: 'ok',
  });
  assert.equal(unpricedImage.settled, false);
  assert.equal(unpricedImage.reason, 'missing_price');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM credit_ledger WHERE charge_ref_id = 'usage:image:image-smoke-unpriced'").get() as any).c,
    0,
  );
  assert.equal(
    (db.prepare("SELECT billing_status FROM token_usage_events WHERE operation_key = 'image-smoke-unpriced'").get() as any).billing_status,
    'unsettled',
  );

  console.log('[usage-billing] smoke passed');
}

main()
  .finally(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
