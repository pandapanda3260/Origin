import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function GET() { return jsonOk({ tracks: [], clips: [], duration: 0 }); }
export async function PUT() { return jsonOk({ ok: true }); }
