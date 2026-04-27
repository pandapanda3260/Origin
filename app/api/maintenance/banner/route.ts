import { MOCK_MAINTENANCE_BANNER } from '@/mocks/config';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk(MOCK_MAINTENANCE_BANNER);
}
