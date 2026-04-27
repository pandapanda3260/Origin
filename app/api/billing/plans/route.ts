import { MOCK_BILLING_PLANS } from '@/mocks/billing';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk({ plans: MOCK_BILLING_PLANS });
}
