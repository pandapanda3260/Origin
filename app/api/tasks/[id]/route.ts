import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return jsonOk({ id: params.id, status: 'completed', progress: 100, result: null });
}

export async function DELETE() { return jsonOk({ ok: true }); }
