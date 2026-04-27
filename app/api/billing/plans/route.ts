import { jsonOk } from '@/lib/api-helpers';
import { PLANS, TOPUP_PACKS } from '@/lib/billing-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk({ plans: PLANS, topupPacks: TOPUP_PACKS });
}
