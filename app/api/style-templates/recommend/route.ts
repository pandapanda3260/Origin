import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { recommendStyleTemplateForWorld } from '@/lib/style-templates-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const worldTemplateId = req.nextUrl.searchParams.get('worldId') || req.nextUrl.searchParams.get('worldTemplateId') || '';
  const ownerRaw = req.nextUrl.searchParams.get('worldOwnerId') || req.nextUrl.searchParams.get('worldTemplateOwnerId') || '';
  const worldTemplateOwnerId = ownerRaw ? Number(ownerRaw) : undefined;
  const result = recommendStyleTemplateForWorld(user.id, { worldTemplateId, worldTemplateOwnerId });
  return jsonOk(result);
}

