import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const idea = body.oneSentence || body.idea || '一段示例创意';
  return jsonOk({
    title: '示例剧本：' + idea.slice(0, 24),
    script: `# ${idea}\n\n[场景一] 清晨的城市天台。\n主角仰望天空，独白：\n"如果今天是最后一天，我想做点不一样的事。"\n\n[场景二] 镜头切换到地铁站，主角穿过人群，与各色路人擦肩而过。\n旁白：\n"每个人都在赶路，但谁在等我？"\n\n[场景三] 黄昏，主角站在桥上，远处霓虹亮起。\n微笑：\n"也许，明天会更好。"\n`,
    styleBible: {
      vision: '电影感、低饱和、暖色调',
      narrative: '内心独白驱动，节奏舒缓',
      camera: '手持轻微晃动 + 中近景特写',
      mood: '怀旧、希望、温柔',
      promptHabits: '中英混排，风格关键词靠前',
    },
    emotions: [
      { time: '0:00-0:08', label: '低落', intensity: 0.4 },
      { time: '0:08-0:18', label: '平静', intensity: 0.5 },
      { time: '0:18-0:30', label: '希望', intensity: 0.8 },
    ],
    tokens: 1200,
  });
}
