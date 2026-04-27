import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() { return jsonOk({ ok: true, prompt: '[mock] parsed prompt' }); }
