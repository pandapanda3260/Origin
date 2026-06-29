import { getBalance } from './credits';

export function toBillingOrderPayload(row: any, userId: number) {
  const meta = parseMetaJson(row?.meta_json);
  return {
    id: row.id,
    kind: row.kind,
    planCode: row.plan_code,
    provider: row.provider,
    title: typeof meta.title === 'string' ? meta.title : '',
    amountCents: row.amount_cents,
    currency: row.currency,
    creditsAdded: row.credits_added,
    status: row.status,
    periodEnd: row.kind === 'subscription' && row.status === 'applied' ? getBalance(userId).periodEnd : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseMetaJson(raw: string) {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
