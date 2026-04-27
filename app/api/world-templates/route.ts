import { MOCK_WORLD_TEMPLATES } from '@/mocks/library';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk({ items: MOCK_WORLD_TEMPLATES, total: 0 });
}

export async function POST() {
  return jsonOk({ ok: true, message: '[mock] 模板已收藏（本地）' });
}
