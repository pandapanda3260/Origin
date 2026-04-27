import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    emotions: [
      { time: '0:00-0:08', label: '低落', intensity: 0.4 },
      { time: '0:08-0:18', label: '平静', intensity: 0.5 },
      { time: '0:18-0:30', label: '希望', intensity: 0.8 },
    ],
  });
}
