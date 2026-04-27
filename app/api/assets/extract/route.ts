import { jsonOk } from '@/lib/api-helpers';
export const dynamic = 'force-dynamic';
export async function POST() {
  return jsonOk({
    characters: [
      { id: 'c1', name: '主角', description: '青年男性，干净阳光，穿浅灰卫衣', referenceImage: null, locked: false },
      { id: 'c2', name: '路人A', description: '中年女性，戴墨镜', referenceImage: null, locked: false },
    ],
    environments: [
      { id: 'e1', name: '城市天台', description: '清晨日出，云层与高楼天际线', referenceImage: null },
      { id: 'e2', name: '地铁站', description: '通勤高峰，灯光偏冷', referenceImage: null },
      { id: 'e3', name: '黄昏天桥', description: '霓虹初亮，远处车流', referenceImage: null },
    ],
    props: [
      { id: 'p1', name: '一只白色咖啡杯', description: '手持镜头特写道具' },
    ],
  });
}
