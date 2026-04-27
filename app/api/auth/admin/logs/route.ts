import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { readLogs, totalLogs } from '@/lib/sys-logs';
import '@/lib/init-executors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  if (!user.is_admin) return jsonError('forbidden', 403);

  const url = new URL(req.url);
  const level = (url.searchParams.get('level') || 'all') as 'warning' | 'all';
  const lines = Math.max(1, Number(url.searchParams.get('lines') || 300));

  const entries = readLogs({ level, lines });
  const formatted = entries.map((e) => `[${new Date(e.ts).toISOString()}][${e.level.toUpperCase()}] ${e.message}`);

  return jsonOk({
    file: 'memory-ring-buffer',
    total: totalLogs(),
    lines: formatted,
  });
}
