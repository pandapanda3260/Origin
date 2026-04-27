import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { resolveLLMConfig } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  if (!user.is_admin) return jsonError('forbidden', 403);

  const slots: ('text' | 'image' | 'video' | 'storyboard')[] = ['text', 'image', 'video', 'storyboard'];
  const pools = slots.map((slot) => {
    const cfg = resolveLLMConfig(user, slot);
    return {
      name: slot,
      total: 1,
      healthy: cfg.mode === 'real' ? 1 : 0,
      exhausted: 0,
      mode: cfg.mode,
      source: cfg.source,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      lastUsed: null,
    };
  });

  return jsonOk({ pools, updatedAt: new Date().toISOString() });
}
