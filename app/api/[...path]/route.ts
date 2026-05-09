import { NextRequest, NextResponse } from 'next/server';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const safeBody = (path: string) => ({
  ok: true,
  mock: true,
  detail: `[mock-fallback] ${path} 未在本地实现，返回空数据。如果某个页面缺数据，请告诉我具体是哪个接口，我会补上对应 mock。`,
  items: [],
  total: 0,
  data: null,
});

const notImplementedBody = (path: string, audited: boolean) => ({
  ok: false,
  mock: true,
  code: 'NOT_IMPLEMENTED',
  detail: audited
    ? `[mock-audit] ${path} 未实现。请在 data/mock-audit.jsonl 查看真实调用来源，并把该接口标记为补实现、显式未实现、下掉入口或前端清理。`
    : `[mock-audit] ${path} 未实现。当前为 deny 模式，未写入审计文件。`,
  items: [],
  total: 0,
  data: null,
});

const auditPath = join(process.cwd(), 'data', 'mock-audit.jsonl');
const DEFAULT_AUDIT_MAX_BYTES = 1024 * 1024;

function fallbackMode() {
  const raw = String(process.env.MOCK_FALLBACK_MODE || '').trim().toLowerCase();
  if (raw === 'allow' || raw === 'audit' || raw === 'deny') return raw;
  return process.env.NODE_ENV === 'production' ? 'deny' : 'audit';
}

function auditMaxBytes() {
  const n = Number(String(process.env.MOCK_AUDIT_MAX_BYTES || '').trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUDIT_MAX_BYTES;
  return Math.max(4096, Math.round(n));
}

function shouldWriteAudit(mode: string) {
  return mode === 'audit' && process.env.NODE_ENV !== 'production';
}

function writeAudit(req: NextRequest, path: string, url: URL) {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    if (existsSync(auditPath) && statSync(auditPath).size >= auditMaxBytes()) {
      console.warn('[mock-audit] size cap reached, skip writing:', auditPath);
      return false;
    }
    appendFileSync(
      auditPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path,
        search: url.search || '',
        referer: req.headers.get('referer') || '',
        ua: req.headers.get('user-agent') || '',
      }) + '\n',
    );
    return true;
  } catch (e) {
    console.warn('[mock-audit] write failed:', e);
    return false;
  }
}

function handle(req: NextRequest, { params }: { params: { path: string[] } }) {
  const path = '/api/' + (params.path || []).join('/');
  const url = new URL(req.url);
  const mode = fallbackMode();

  if (mode === 'allow') {
    console.log(`[mock-fallback] ${req.method} ${path}${url.search}`);
    return NextResponse.json(safeBody(path), { status: 200 });
  }

  const audited = shouldWriteAudit(mode) ? writeAudit(req, path, url) : false;
  return NextResponse.json(notImplementedBody(path, audited), { status: 501 });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
