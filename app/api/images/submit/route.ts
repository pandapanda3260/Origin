import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { generateImage } from '@/lib/image-gen';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单图同步生成入口（不走 batch）。
 * 适用场景：用户在某个角色卡片上单独点"重新生成参考图"等。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const prompt: string = (body.prompt || body.imagePrompt || '').toString().trim();
  if (!prompt) return jsonError('缺 prompt', 400);

  const kind = (body.kind || 'other').toString();
  const projectId: string | undefined = body.projectId;
  const assetRef: string | undefined = body.assetRef;
  const size = body.size || '1024x1024';
  const style = body.style || (kind === 'storyboard' ? 'pencil' : 'natural');

  try {
    const result = await generateImage(user, {
      prompt,
      size,
      style,
      kind: ['character', 'scene', 'prop', 'storyboard'].includes(kind) ? kind : 'other',
      projectId,
      assetRef,
    } as any);
    return jsonOk({
      ok: true,
      taskId: result.id,
      url: result.url,
      width: result.width,
      height: result.height,
      mode: result.mode,
    });
  } catch (e: any) {
    return jsonError('图像生成失败：' + (e?.message || String(e)), 502);
  }
}
