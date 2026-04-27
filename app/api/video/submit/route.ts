import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { generateVideo } from '@/lib/video-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单视频同步生成（不走 batch）。
 * 接口契约 1:1：返回 { ok, taskId, status, url, coverUrl, durationSec, mode }
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const prompt: string = (body.prompt || body.videoPrompt || '').toString().trim();
  if (!prompt) return jsonError('缺 prompt', 400);

  try {
    const result = await generateVideo(user, {
      prompt,
      size: body.size || '1080x1920',
      durationSec: body.durationSec || 4,
      projectId: body.projectId,
      groupIdx: body.groupIdx,
    });
    return jsonOk({
      ok: true,
      taskId: result.taskId,
      status: result.status,
      url: result.url,
      coverUrl: result.coverUrl,
      durationSec: result.durationSec,
      mode: result.mode,
    });
  } catch (e: any) {
    return jsonError('视频生成失败：' + (e?.message || String(e)), 502);
  }
}
