/**
 * 一次性重算「素材库热存配额」缓存（quota_usage 表）。
 *
 * 背景：是否超额会被缓存在 quota_usage.is_over_quota，只有在新增/删除素材时才会重算。
 * 所以调大了 lib/asset-library.ts 里的 ASSET_LIBRARY_LIMITS 上限后，必须跑一次本脚本，
 * 让系统按新上限重新判定一遍，否则旧的「已超额」标记会继续把你拦住。
 *
 * 用法（在项目根目录）：
 *   npx tsx scripts/refresh-asset-quota.ts        # 重算所有用户
 *   npx tsx scripts/refresh-asset-quota.ts 1      # 只重算 owner_id=1
 */
import { getDb } from '../lib/db';
import { refreshQuotaUsage } from '../lib/asset-library';

function mb(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function main() {
  const argId = Number(process.argv[2]);
  const db = getDb();

  let ownerIds: number[];
  if (Number.isInteger(argId) && argId > 0) {
    ownerIds = [argId];
  } else {
    const rows = db.prepare('SELECT DISTINCT owner_id FROM assets').all() as Array<{ owner_id: number }>;
    ownerIds = rows.map((r) => Number(r.owner_id)).filter((n) => Number.isInteger(n) && n > 0);
  }

  for (const ownerId of ownerIds) {
    const q = refreshQuotaUsage(ownerId);
    console.log(
      `owner ${ownerId}: 图片 ${mb(q.hotImageBytes)} / 视频 ${mb(q.hotVideoBytes)} / 合计 ${mb(q.hotTotalBytes)} ` +
        `=> 超额? ${q.isOverQuota ? '是（仍超新上限）' : '否（已解封）'}`,
    );
  }
  console.log(`完成，已重算 ${ownerIds.length} 个用户的配额。`);
}

main();
