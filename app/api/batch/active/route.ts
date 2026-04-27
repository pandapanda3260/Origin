import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function GET() { return jsonOk({ items: [], total: 0 }); }
