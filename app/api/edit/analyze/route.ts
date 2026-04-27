import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { chatComplete, parseJsonLoose } from '@/lib/llm';
import { getProjectByIdForUser } from '@/lib/projects-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_EDIT_ANALYZE = `你是短视频后期剪辑助理。给你一个项目的剧本 + 镜头表 + 已生成的视频片段元数据，请返回结构化的"剪辑维度分析"。
输出严格 JSON：
{
  "narrative": "故事弧线总结（80-150 字，描述本片的情绪曲线、关键转折、节奏节拍）",
  "tags": [
    { "id": "t1", "label": "都市", "color": "#90A4AE" },
    { "id": "t2", "label": "希望", "color": "#0B1320" }
  ],
  "segments": [
    {
      "id": "s1",
      "groupIdx": 0,
      "label": "开场建立",
      "tags": ["t1"],
      "intensity": 0.4,
      "suggestedCut": "前 3 秒挂悬念问题"
    }
  ]
}
约束：
- segments 数量等于已有视频片段数；按时间顺序输出
- intensity 0.0-1.0，符合情绪强度
- tags 总数 3-6 个，给整片做分类标签`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  if (!projectId) return jsonError('缺 projectId', 400);
  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);

  const ctx = {
    script: (proj as any).script || (proj as any).scriptDraft || '',
    shots: (proj as any).shots || [],
    storyboards: (proj as any).storyboards || [],
    videoTasks: (proj as any).videoTasks || [],
  };

  try {
    const raw = await chatComplete(
      user,
      [
        { role: 'system', content: SP_EDIT_ANALYZE },
        { role: 'user', content: JSON.stringify(ctx) },
      ],
      { temperature: 0.4, responseFormat: 'json_object', maxTokens: 1200 },
    );
    const json = parseJsonLoose(raw);
    return jsonOk({
      narrative: json.narrative || '',
      tags: Array.isArray(json.tags) ? json.tags : [],
      segments: Array.isArray(json.segments) ? json.segments : [],
    });
  } catch (e: any) {
    return jsonError('分析失败：' + (e?.message || String(e)), 502);
  }
}
