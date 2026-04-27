import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ prompt: '[mock] 已重建提示词：cinematic, warm tones, soft lighting, 35mm' });
}
