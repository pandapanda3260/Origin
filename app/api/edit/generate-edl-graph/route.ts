import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { sseResponse } from '@/lib/sse';
import {
  resumeEdlGraphRun,
  startEdlGraphRun,
} from '@/lib/edit-edl-graph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response(
      `data: ${JSON.stringify({ type: 'error', error: 'unauthorized' })}\n\n`,
      { status: 401, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  const body = await req.json().catch(() => ({} as any));

  return sseResponse(async (writer) => {
    const emit = (event: any) => {
      if (event.type === 'chunk') writer.chunk(event.content || '');
      else if (event.type === 'step') writer.step(event.label || '');
      else if (event.type === 'phase') writer.phase(event.name || 'graph', event.extra || {});
    };

    try {
      const action = String(body?.action || '');
      const threadId = typeof body?.threadId === 'string' ? body.threadId : '';
      const isResume = !!threadId && ['approve', 'reject', 'discard', 'rerun'].includes(action);
      const result = isResume
        ? await resumeEdlGraphRun({
            user,
            threadId,
            action: action as any,
            emit,
          })
        : await startEdlGraphRun({
            user,
            projectId: String(body?.projectId || ''),
            targetDurationSec: Number(body?.targetDurationSec || body?.durationSec || 30),
            segments: Array.isArray(body?.segments) ? body.segments : [],
            emit,
          });

      if (result.needsApproval) {
        writer.event('needs_approval', {
          threadId: result.threadId,
          runId: result.runId,
          projectId: result.projectId,
          approvalType: result.interrupt?.type || 'edl_approval',
          interrupt: result.interrupt,
          draftResult: result.draftResult,
          qcWarnings: result.qcWarnings,
          conflict: result.conflict,
        });
      }

      if (result.status && String(result.status).startsWith('failed')) {
        writer.error(result.error || 'EDL graph 运行失败');
        return;
      }

      writer.done({
        ...result,
        result: result.commitResult?.result || result.draftResult || null,
        serverVersion: result.commitResult?.serverVersion,
      });
    } catch (e: any) {
      writer.error(e?.message || String(e));
    }
  });
}
