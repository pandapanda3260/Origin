import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() { return jsonOk({ ok: true, message: '[mock] 已取消（本地）' }); }
