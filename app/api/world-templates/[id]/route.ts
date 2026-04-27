import { NextRequest } from 'next/server';
import { jsonOk, jsonError } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return jsonError('模板不存在（mock）', 404);
}

export async function DELETE() {
  return jsonOk({ ok: true });
}
