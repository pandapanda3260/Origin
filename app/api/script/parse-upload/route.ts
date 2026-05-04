import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TEXT_BYTES = 5 * 1024 * 1024;  // 5 MB 纯文本上限
const MAX_REQUEST_BYTES = MAX_TEXT_BYTES + 512 * 1024;

/**
 * 解析用户上传的剧本文件 → 纯文本。
 * 当前仅支持纯文本文件（txt / md），后续接 docx/pdf 解析时改这里。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_REQUEST_BYTES) {
    return jsonError(`请求过大：超过 ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB`, 413);
  }

  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file') as File | null;
      if (!file) return jsonError('没有上传文件', 400);
      const declaredSize = Number((file as any).size || 0);
      if (declaredSize && declaredSize > MAX_TEXT_BYTES) {
        return jsonError(`剧本过大：最大 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)} MB`, 413);
      }
      const buf = await file.arrayBuffer();
      if (buf.byteLength > MAX_TEXT_BYTES) {
        return jsonError(`剧本过大：最大 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)} MB`, 413);
      }
      const text = new TextDecoder('utf-8').decode(buf);
      return jsonOk({ text, meta: { filename: (file as any).name || 'upload', size: buf.byteLength } });
    }
    if (ct.includes('application/json')) {
      const body = await req.json();
      const t = String(body.text || '');
      if (t.length > MAX_TEXT_BYTES) return jsonError('剧本过长', 413);
      return jsonOk({ text: t, meta: {} });
    }
    const txt = await req.text();
    if (txt.length > MAX_TEXT_BYTES) return jsonError('剧本过长', 413);
    return jsonOk({ text: txt, meta: {} });
  } catch (e: any) {
    return jsonError('解析失败：' + (e?.message || String(e)), 400);
  }
}
