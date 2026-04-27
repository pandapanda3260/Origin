import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({ prompt: '[mock] cinematic, soft warm tones, 35mm, shallow depth of field' });
}
