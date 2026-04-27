import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function GET() {
  return jsonOk({
    items: [
      { id: 'b1', name: '城市清晨', mood: '希望', duration: 90, url: null },
      { id: 'b2', name: '霓虹夜色', mood: '怀旧', duration: 120, url: null },
      { id: 'b3', name: '节奏律动', mood: '活力', duration: 85, url: null },
    ],
    total: 3,
  });
}
