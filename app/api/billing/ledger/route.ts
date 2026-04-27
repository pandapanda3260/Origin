import { MOCK_BILLING_LEDGER } from '@/mocks/billing';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk(MOCK_BILLING_LEDGER);
}
