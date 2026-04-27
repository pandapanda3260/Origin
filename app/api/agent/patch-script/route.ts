import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ ok: true, patches: [], message: '[mock] 已记录修改意图（本地）' });
}
