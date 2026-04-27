import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    reply: '[mock] Creative Agent 收到你的指令。本地开发版未连真实大模型，先返回示例回复。',
    patches: [],
  });
}
