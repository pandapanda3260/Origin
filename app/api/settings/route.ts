import { NextRequest } from 'next/server';
import { MOCK_USER_SETTINGS } from '@/mocks/settings';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

const STATE = { ...MOCK_USER_SETTINGS };

export async function GET() {
  return jsonOk(STATE);
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  Object.assign(STATE, body, { updatedAt: new Date().toISOString() });
  return jsonOk(STATE);
}
