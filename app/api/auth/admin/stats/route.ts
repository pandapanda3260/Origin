import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { detail: 'Gone. Use /api/admin/stats with admin_token.' },
    { status: 410 },
  );
}
