import { NextRequest } from 'next/server';
import { MOCK_TOKEN, MOCK_USER } from '@/mocks/user';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = (body.username || '').trim() || 'newuser';
  return jsonOk({
    token: MOCK_TOKEN,
    user: { ...MOCK_USER, username, displayName: username, email: body.email || '' },
  });
}
