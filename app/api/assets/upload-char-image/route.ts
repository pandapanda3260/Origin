import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ ok: true, url: '/showcase-asset-1.jpg', message: '[mock] 上传成功（本地用占位图）' });
}
