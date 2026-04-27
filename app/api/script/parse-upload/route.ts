import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 解析用户上传的剧本文件 → 纯文本。
 * 当前仅支持纯文本文件（txt / md），后续接 docx/pdf 解析时改这里。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file') as File | null;
      if (!file) return jsonError('没有上传文件', 400);
      const buf = await file.arrayBuffer();
      const text = new TextDecoder('utf-8').decode(buf);
      return jsonOk({ text, meta: { filename: (file as any).name || 'upload', size: buf.byteLength } });
    }
    if (ct.includes('application/json')) {
      const body = await req.json();
      return jsonOk({ text: String(body.text || ''), meta: {} });
    }
    const txt = await req.text();
    return jsonOk({ text: txt, meta: {} });
  } catch (e: any) {
    return jsonError('解析失败：' + (e?.message || String(e)), 400);
  }
}
