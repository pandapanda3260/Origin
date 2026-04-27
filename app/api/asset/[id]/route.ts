import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function GET() { return jsonOk({ url: '/showcase-asset-1.jpg', meta: {} }); }
export async function PUT() { return jsonOk({ ok: true }); }
export async function DELETE() { return jsonOk({ ok: true }); }
