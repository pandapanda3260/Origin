import { MOCK_CLIENT_CONFIG } from '@/mocks/config';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk(MOCK_CLIENT_CONFIG);
}
