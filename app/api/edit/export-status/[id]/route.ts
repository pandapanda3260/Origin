import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function GET() {
  return jsonOk({ status: 'pending', progress: 0, url: null, message: '[mock] 渲染中' });
}
