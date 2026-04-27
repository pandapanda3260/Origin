import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { chatComplete, parseJsonLoose } from '@/lib/llm';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SP_GENERATE_EDL = `你是 AI 剪辑师。给你一组已生成的视频片段（每条带：clipId、durationSec、prompt、关联镜头描述），
请决定：
1) 排列顺序（可调整原顺序）
2) 每段保留多少秒（可裁剪两端）
3) 转场（cut / fade / dissolve / wipe）

输出严格 JSON：
{
  "edl": [
    {
      "clipId": "c1",
      "in": 0.0,
      "out": 3.5,
      "transitionIn": "cut",
      "transitionOut": "fade",
      "note": "开场建立"
    }
  ],
  "duration": 25.5,
  "narrative": "整体节奏描述（30 字以内）"
}

约束：
- 总时长在用户给的"目标时长 ±20%"内（默认 30s）
- 不要重复同一个 clipId
- in/out 必须在 [0, 该 clip 的 durationSec] 范围内
- transitionIn/transitionOut 只用 cut / fade / dissolve / wipe`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const projectId: string | undefined = body.projectId;
  const targetDurationSec: number = body.targetDurationSec || body.durationSec || 30;
  if (!projectId) return jsonError('缺 projectId', 400);

  const proj = getProjectByIdForUser(projectId, user.id);
  if (!proj) return jsonError('项目不存在', 404);

  // 收集所有"已完成"的视频片段
  const db = getDb();
  const videos = db
    .prepare<{ uid: number; pid: string }, any>(
      `SELECT id, group_idx, prompt, duration_sec, filename FROM video_tasks
       WHERE owner_id = @uid AND project_id = @pid AND status = 'completed'
       ORDER BY group_idx ASC, created_at ASC`,
    )
    .all({ uid: user.id, pid: projectId });

  if (!videos.length) return jsonError('当前还没有已生成的视频片段，先去批量页生成', 400);

  const clips = videos.map((v: any) => ({
    clipId: v.id,
    durationSec: v.duration_sec || 4,
    groupIdx: v.group_idx,
    prompt: (v.prompt || '').slice(0, 300),
  }));

  const ctx = {
    targetDurationSec,
    clips,
    script: ((proj as any).script || (proj as any).scriptDraft || '').slice(0, 2000),
    shots: (proj as any).shots || [],
  };

  try {
    const raw = await chatComplete(
      user,
      [
        { role: 'system', content: SP_GENERATE_EDL },
        { role: 'user', content: JSON.stringify(ctx) },
      ],
      { temperature: 0.5, responseFormat: 'json_object', maxTokens: 1500 },
    );
    const json = parseJsonLoose<any>(raw);
    let edl = Array.isArray(json.edl) ? json.edl : [];
    // 校验：in/out 落在 clip 真实 duration 范围内
    const clipMap = new Map(clips.map((c) => [c.clipId, c]));
    edl = edl
      .filter((e: any) => clipMap.has(e.clipId))
      .map((e: any) => {
        const c = clipMap.get(e.clipId)!;
        const inSec = clamp(Number(e.in ?? 0), 0, c.durationSec - 0.5);
        const outSec = clamp(Number(e.out ?? c.durationSec), inSec + 0.5, c.durationSec);
        return {
          clipId: e.clipId,
          in: inSec,
          out: outSec,
          transitionIn: pickEnum(e.transitionIn, ['cut', 'fade', 'dissolve', 'wipe'], 'cut'),
          transitionOut: pickEnum(e.transitionOut, ['cut', 'fade', 'dissolve', 'wipe'], 'cut'),
          note: String(e.note || '').slice(0, 200),
        };
      });
    if (!edl.length) {
      // 兜底：原顺序拼一遍
      edl = clips.map((c) => ({
        clipId: c.clipId,
        in: 0,
        out: c.durationSec,
        transitionIn: 'cut',
        transitionOut: 'cut',
        note: 'fallback',
      }));
    }
    const duration = edl.reduce((s: number, e: any) => s + (e.out - e.in), 0);
    return jsonOk({
      edl,
      duration,
      narrative: json.narrative || '',
      message: '[mock] AI 自动剪辑结果',
    });
  } catch (e: any) {
    return jsonError('EDL 生成失败：' + (e?.message || String(e)), 502);
  }
}

function clamp(v: number, lo: number, hi: number) {
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
function pickEnum(v: any, list: string[], dflt: string) {
  const s = String(v || '').toLowerCase().trim();
  return list.includes(s) ? s : dflt;
}
