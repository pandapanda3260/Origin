import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { estimateRecentVideoGenerationSeconds } from '@/lib/video-generation-estimate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') || 10);
  const estimate = estimateRecentVideoGenerationSeconds(getDb(), user.id, limit);

  return jsonOk(estimate);
}
