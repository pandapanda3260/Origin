import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    prompts: [
      { shotIdx: 1, prompt: '[mock] wide aerial city skyline at dawn, cinematic, slow push-in' },
      { shotIdx: 2, prompt: '[mock] close-up of protagonist face, determined eyes, soft warm light' },
    ],
  });
}
