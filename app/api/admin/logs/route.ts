import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/api-helpers';
import { withAdminAudit } from '@/lib/admin-audit';
import { readLogs, totalLogs } from '@/lib/sys-logs';
import { listObservabilityEvents } from '@/lib/observability-events';
import '@/lib/init-executors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAdminAudit(async function listAuditLogs(req: NextRequest) {
  const url = new URL(req.url);
  const level = (url.searchParams.get('level') || 'all') as 'warning' | 'all';
  const lines = Math.max(1, Number(url.searchParams.get('lines') || 300));

  const entries = readLogs({ level, lines });
  const persistent = [
    ...listObservabilityEvents({ type: 'system_warn', level, limit: lines }),
    ...listObservabilityEvents({ type: 'system_error', level, limit: lines }),
  ];
  const formatted = [
    ...persistent.map((event) => ({
      ts: Date.parse(event.createdAt) || 0,
      line: `[${event.createdAt}][${String(event.status || event.type).toUpperCase()}][persistent] ${event.message}`,
    })),
    ...entries.map((e) => ({
      ts: e.ts,
      line: `[${new Date(e.ts).toISOString()}][${e.level.toUpperCase()}] ${e.message}`,
    })),
  ]
    .sort((a, b) => a.ts - b.ts)
    .slice(-lines)
    .map((item) => item.line);

  return jsonOk({
    file: 'memory-ring-buffer+observability_events',
    total: totalLogs() + persistent.length,
    lines: formatted,
  });
}, 'audit.list', {
  category: 'audit',
  safe: true,
});
