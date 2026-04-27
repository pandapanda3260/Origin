import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ text: '[mock] 解析后的剧本文本（本地未上传文件）', meta: {} });
}
