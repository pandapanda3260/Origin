import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function POST() {
  return jsonOk({
    orderId: 'mock-order-' + Date.now(),
    payUrl: 'about:blank',
    qrCode: '',
    message: '[mock] 本地开发未对接支付，订单为虚拟订单',
  });
}
