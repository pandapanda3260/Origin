import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function POST() {
  return jsonOk({ ok: true, message: '[mock] 验证码已发送（本地开发，验证码任意）' });
}
