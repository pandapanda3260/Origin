import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ ok: true, latencyMs: 230, message: '[mock] 连通正常（本地）' });
}
