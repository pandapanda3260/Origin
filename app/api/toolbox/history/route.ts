import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { listToolboxItems } from '@/lib/toolbox-db';
import type { ToolboxStatus, ToolboxToolType } from '@/lib/toolbox-modes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseTool(raw: string | null): ToolboxToolType | null {
  if (raw === 'image' || raw === 'video') return raw;
  return null;
}

function parseStatus(raw: string | null): ToolboxStatus | null {
  if (raw === 'running' || raw === 'completed' || raw === 'failed') return raw;
  return null;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const tool = parseTool(url.searchParams.get('tool'));
  const status = parseStatus(url.searchParams.get('status'));
  const limit = Number(url.searchParams.get('limit') || 0);
  const cursor = url.searchParams.get('cursor');

  const result = listToolboxItems({
    ownerId: user.id,
    toolType: tool,
    status,
    limit,
    cursor,
  });
  return jsonOk({ ok: true, ...result });
}
