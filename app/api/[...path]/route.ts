import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const safeBody = (path: string) => ({
  ok: true,
  mock: true,
  detail: `[mock-fallback] ${path} 未在本地实现，返回空数据。如果某个页面缺数据，请告诉我具体是哪个接口，我会补上对应 mock。`,
  items: [],
  total: 0,
  data: null,
});

function handle(req: NextRequest, { params }: { params: { path: string[] } }) {
  const path = '/api/' + (params.path || []).join('/');
  const url = new URL(req.url);
  console.log(`[mock-fallback] ${req.method} ${path}${url.search}`);
  return NextResponse.json(safeBody(path), { status: 200 });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
