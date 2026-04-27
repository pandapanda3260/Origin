import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    narrative: '[mock] 故事弧线：开场设悬念 → 中段铺情 → 结尾升华',
    tags: [
      { id: 't1', label: '都市', color: '#90A4AE' },
      { id: 't2', label: '希望', color: '#0B1320' },
    ],
  });
}
