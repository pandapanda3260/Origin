import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ script: '[mock] 续写：故事在天台落幕，主角对未来充满期待。' });
}
