import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SENSITIVE_KEYWORDS = [
  'nude', 'naked', 'sex', 'gore', 'blood', 'kill', 'murder', 'suicide',
  '裸', '色情', '血腥', '杀', '自杀',
];

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const text: string = (body.text || body.prompt || '').toString();
  const lower = text.toLowerCase();
  const hits: { term: string; index: number }[] = [];
  for (const k of SENSITIVE_KEYWORDS) {
    const i = lower.indexOf(k.toLowerCase());
    if (i >= 0) hits.push({ term: k, index: i });
  }
  return jsonOk({ flagged: hits.length > 0, hits });
}
