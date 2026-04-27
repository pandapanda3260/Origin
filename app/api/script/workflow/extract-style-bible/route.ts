import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    styleBible: {
      vision: '电影感、低饱和、暖色调',
      narrative: '内心独白驱动，节奏舒缓',
      camera: '手持轻微晃动 + 中近景特写',
      mood: '怀旧、希望、温柔',
      promptHabits: '中英混排，风格关键词靠前',
    },
  });
}
