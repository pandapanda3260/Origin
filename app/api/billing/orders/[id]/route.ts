import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return jsonOk({
    id: params.id,
    status: 'pending',
    amount: 0,
    currency: 'CNY',
    message: '[mock] 订单状态为虚拟（本地）',
  });
}
