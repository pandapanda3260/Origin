import { NextRequest } from 'next/server';
import { getCurrentUser, verifyToken } from '@/lib/auth';
import { getDb, type UserRow } from '@/lib/db';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getModelRoutingStatus } from '@/lib/model-routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getAdminStatusUser(req);
  if (!user) return jsonError('unauthorized', 401);
  if (!user.is_admin) return jsonError('forbidden', 403);

  const status = getModelRoutingStatus(user);
  const pools = (['brain', 'structured', 'image', 'video'] as const).map((slot) => {
    const cfg = status[slot];
    return {
      name: slot,
      total: 1,
      healthy: cfg.mode === 'real' ? 1 : 0,
      exhausted: 0,
      mode: cfg.mode,
      source: cfg.source,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      provider: cfg.provider,
      endpoint: cfg.endpoint || cfg.imageGenerationEndpoint || null,
      lastUsed: null,
    };
  });

  return jsonOk({ pools, env: status.env, updatedAt: new Date().toISOString() });
}

async function getAdminStatusUser(req: NextRequest): Promise<UserRow | null> {
  const bearerUser = await getCurrentUser(req);
  if (bearerUser) return bearerUser;

  const headerToken = (req.headers.get('x-admin-token') || '').trim();
  if (!headerToken) return null;
  const decoded = await verifyToken(headerToken);
  if (!decoded) return null;
  return getDb()
    .prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id')
    .get({ id: decoded.userId }) ?? null;
}
