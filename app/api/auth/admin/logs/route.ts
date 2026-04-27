import { MOCK_ADMIN_LOGS } from '@/mocks/admin';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk(MOCK_ADMIN_LOGS);
}
