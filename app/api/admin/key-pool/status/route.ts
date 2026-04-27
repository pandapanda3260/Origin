import { MOCK_ADMIN_KEY_POOL } from '@/mocks/config';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk(MOCK_ADMIN_KEY_POOL);
}
