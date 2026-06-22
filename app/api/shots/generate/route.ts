import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest) {
  return Response.json(
    {
      detail: 'deprecated_endpoint',
      message: '镜头表生成已迁移到后台批处理，请使用 /api/batch/start，batchType=shots。',
      replacement: '/api/batch/start',
      batchType: 'shots',
    },
    { status: 410 },
  );
}
