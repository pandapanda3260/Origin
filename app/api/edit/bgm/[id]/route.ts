import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function GET() {
  return jsonOk({ url: null, message: '[mock] BGM 资源占位（本地未提供音频文件）' });
}
