import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import {
  listArchivedUserCards,
  listSystemAndUserCards,
} from '@/lib/knowledge/cards-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USER_CARD_MODULES = new Set([
  'narrative_structure',
  'style_bible',
  'asset_extraction',
  'identity_consistency',
  'shot_design',
  'storyboard_prompt',
  'frame_image',
  'video_prompt',
  'video_prompt_refine',
  'provider_runtime',
  'edit_strategy',
  'audio_subtitle_export',
]);

function normalizeModule(value: unknown): string {
  const knowledgeModule = String(value || '').trim();
  return USER_CARD_MODULES.has(knowledgeModule) ? knowledgeModule : '';
}

function parseBool(value: unknown): boolean {
  const raw = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function clampLimit(value: unknown): number {
  const n = Math.floor(Number(value || 50));
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(100, n));
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const url = new URL(req.url);
  const knowledgeModule = normalizeModule(url.searchParams.get('module'));
  if (!knowledgeModule) return jsonError('module not allowed', 400);
  const limit = clampLimit(url.searchParams.get('limit'));
  const includeArchived = parseBool(url.searchParams.get('includeArchived'));
  const cards = listSystemAndUserCards(user.id, knowledgeModule, { limit });
  if (includeArchived) {
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const card of listArchivedUserCards(user.id, knowledgeModule, { limit })) byId.set(card.id, card);
    return jsonOk({ cards: Array.from(byId.values()) });
  }
  return jsonOk({ cards });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  return jsonError('knowledge cards user write API is not enabled', 404);
}
