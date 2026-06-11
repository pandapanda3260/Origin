/**
 * 模拟支付到账 + 订阅月度重置 + 扣减优先级反转 契约测试
 * （docs/billing-pricing-and-card-display-plan.md §2/§3，2026-06-10 方向B拍板）
 *
 * 运行（务必用临时 DB，别碰 data/qd.sqlite；沙箱跑不了 better-sqlite3，需本机）：
 *   DB_PATH=/tmp/qd-test-billing-autopay.sqlite npx tsx scripts/test-billing-autopay.ts
 */
// 红线：lib/db.ts 在模块顶层捕获 DB_PATH（ESM import 提升），脚本内赋默认值来不及；
// 必须由启动命令显式注入临时库，否则会落到 data/qd.sqlite——这里硬性拦截。
if (!process.env.DB_PATH || /(^|[\\/])data[\\/]qd\.sqlite$/.test(process.env.DB_PATH)) {
  console.error('[abort] 必须用临时库运行：DB_PATH=/tmp/qd-test-billing-autopay.sqlite npx tsx scripts/test-billing-autopay.ts');
  process.exit(1);
}
process.env.BILLING_DEV_AUTOPAY = '1';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPlan, getTopupPack, isDevAutopayEnabled, TOPUP_PACKS } from '../lib/billing-config';
import { getDb } from '../lib/db';
import {
  activatePlanSubscription,
  chargeCredits,
  getBalance,
  grantCredits,
  renewDueSubscription,
  settleExpiredSubscription,
} from '../lib/credits';
import { fulfillPaidOrder } from '../lib/billing-fulfill';

// —— 新定价数值锁（2026-06-10 拍板）——
assert.equal(getPlan('plus')?.price_cents, 159900);
assert.equal(getPlan('plus')?.monthly_credits, 80000);
assert.equal(getPlan('pro')?.price_cents, 799900);
assert.equal(getPlan('pro')?.monthly_credits, 400000);
assert.equal(getPlan('free')?.monthly_credits, 100);
assert.deepEqual(
  TOPUP_PACKS.map((p) => [p.code, p.credits, p.price_cents]),
  [
    ['topup_basic', 40000, 100000],
    ['topup_advanced', 120000, 300000],
    ['topup_enterprise', 2000000, 4000000],
  ],
);

// —— 开关语义：默认关 / 非生产显式 1 开 / 0 关 / 生产硬关 ——
process.env.NODE_ENV = 'development';
delete process.env.BILLING_DEV_AUTOPAY;
assert.equal(isDevAutopayEnabled(), false);
process.env.BILLING_DEV_AUTOPAY = '1';
assert.equal(isDevAutopayEnabled(), true);
process.env.BILLING_DEV_AUTOPAY = '0';
assert.equal(isDevAutopayEnabled(), false);
process.env.NODE_ENV = 'production';
process.env.BILLING_DEV_AUTOPAY = '1';
assert.equal(isDevAutopayEnabled(), false);
process.env.NODE_ENV = 'development';
process.env.BILLING_DEV_AUTOPAY = '1';

const db = getDb();
const uid = 990077;

function cleanup() {
  db.prepare('DELETE FROM credit_ledger WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM billing_orders WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM user_credits WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM users WHERE id = ?').run(uid);
}
cleanup();
db.prepare(`INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)`)
  .run(uid, 'billing-autopay-user', 'billing-autopay-user', 'x');

// 开户：free / 100 订阅积分
let bal = getBalance(uid);
assert.equal(bal.planCode, 'free');
assert.equal(bal.subscriptionCredits, 100);

function insertOrder(kind: 'topup' | 'subscription', code: string, credits: number): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO billing_orders (id, user_id, kind, plan_code, provider, amount_cents, credits_added, status, meta_json)
     VALUES (?, ?, ?, ?, 'wechat', 0, ?, 'pending', '{}')`,
  ).run(id, uid, kind, code, credits);
  return id;
}

// —— 积分包到账：topup 桶 + 幂等不双发 ——
const pack = getTopupPack('topup_basic')!;
const topupOrder = insertOrder('topup', pack.code, pack.credits);
const r1 = fulfillPaidOrder({ userId: uid, orderId: topupOrder, via: '模拟支付' });
assert.equal(r1.alreadyApplied, false);
assert.equal(r1.creditsAdded, 40000);
bal = getBalance(uid);
assert.equal(bal.topupCredits, 40000);
assert.equal((db.prepare('SELECT status FROM billing_orders WHERE id = ?').get(topupOrder) as any).status, 'applied');
const r1b = fulfillPaidOrder({ userId: uid, orderId: topupOrder, via: '模拟支付' });
assert.equal(r1b.alreadyApplied, true);
assert.equal(getBalance(uid).topupCredits, 40000); // 不双发

// —— 订阅到账：升档 + 订阅桶覆盖重置 + period_end 未来 ——
const subOrder = insertOrder('subscription', 'plus', getPlan('plus')!.monthly_credits);
const r2 = fulfillPaidOrder({ userId: uid, orderId: subOrder, via: '模拟支付' });
assert.equal(r2.kind, 'subscription');
bal = getBalance(uid);
assert.equal(bal.planCode, 'plus');
assert.equal(bal.subscriptionCredits, 80000); // 覆盖重置（开户 100 不叠加）
assert.equal(bal.topupCredits, 40000); // topup 桶不动
assert.ok(Date.parse(String(bal.periodEnd)) > Date.now());
assert.equal(bal.cancelAtPeriodEnd, false);

// —— 扣减优先级反转：subscription > bonus > topup ——
chargeCredits({ userId: uid, amount: 1000, kind: 'video', reason: 'test charge' });
bal = getBalance(uid);
assert.equal(bal.subscriptionCredits, 79000); // 先烧订阅桶
assert.equal(bal.topupCredits, 40000); // 永久积分纹丝不动
grantCredits({ userId: uid, amount: 100, kind: 'gift', bucket: 'bonus', reason: 'test bonus' });
chargeCredits({ userId: uid, amount: 79050, kind: 'video', reason: 'test charge 2' });
bal = getBalance(uid);
assert.equal(bal.subscriptionCredits, 0); // 订阅桶烧光
assert.equal(bal.bonusCredits, 50); // 再烧 bonus 50
assert.equal(bal.topupCredits, 40000); // topup 仍未动

// —— 惰性月度续费：period_end 过期 + 未取消 → 重置 80000 + 顺延 ——
db.prepare(`UPDATE user_credits SET period_end = ? WHERE user_id = ?`)
  .run(new Date(Date.now() - 40 * 24 * 3600e3).toISOString(), uid);
assert.equal(renewDueSubscription(uid), true);
bal = getBalance(uid);
assert.equal(bal.subscriptionCredits, 80000);
assert.ok(Date.parse(String(bal.periodEnd)) > Date.now());
assert.equal(renewDueSubscription(uid), false); // 未到期不重复续

// —— 申请取消后：不续费，到期降级（与 settle 互斥分流）——
db.prepare(`UPDATE user_credits SET period_end = ?, cancel_at_period_end = 1 WHERE user_id = ?`)
  .run(new Date(Date.now() - 24 * 3600e3).toISOString(), uid);
assert.equal(renewDueSubscription(uid), false);
assert.equal(settleExpiredSubscription(uid), true);
bal = getBalance(uid);
assert.equal(bal.planCode, 'free');
assert.equal(bal.subscriptionCredits, 0);
assert.equal(bal.topupCredits, 40000); // 永久积分降级不回收
assert.equal(bal.bonusCredits, 50);

// —— 开关关掉：到期也不续 ——
activatePlanSubscription(uid, 'pro');
bal = getBalance(uid);
assert.equal(bal.planCode, 'pro');
assert.equal(bal.subscriptionCredits, 400000);
db.prepare(`UPDATE user_credits SET period_end = ? WHERE user_id = ?`)
  .run(new Date(Date.now() - 24 * 3600e3).toISOString(), uid);
process.env.BILLING_DEV_AUTOPAY = '0';
assert.equal(renewDueSubscription(uid), false);
process.env.BILLING_DEV_AUTOPAY = '1';
assert.equal(renewDueSubscription(uid), true);
assert.equal(getBalance(uid).subscriptionCredits, 400000);

// —— 免费档不可订阅 ——
assert.throws(() => activatePlanSubscription(uid, 'free'));

cleanup();
console.log('test-billing-autopay: all assertions passed ✅');
