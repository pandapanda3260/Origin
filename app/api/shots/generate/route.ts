import { jsonOk } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function POST() {
  return jsonOk({
    shots: [
      { idx: 1, duration: 4, framing: '广角', motion: '推', desc: '城市天际线，黎明微光', dialog: '——' },
      { idx: 2, duration: 3, framing: '近景', motion: '固定', desc: '主角侧脸特写，眼神坚定', dialog: '"今天是最后一天。"' },
      { idx: 3, duration: 5, framing: '中景', motion: '跟拍', desc: '人群穿梭的地铁通道', dialog: '——' },
      { idx: 4, duration: 4, framing: '特写', motion: '推', desc: '咖啡杯特写、雾气升腾', dialog: '——' },
      { idx: 5, duration: 6, framing: '大全景', motion: '航拍', desc: '黄昏城市灯光初亮', dialog: '"明天会更好。"' },
    ],
  });
}
