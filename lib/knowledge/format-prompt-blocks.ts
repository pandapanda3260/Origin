import type { KnowledgeCard, KnowledgeContextForStage } from './types';
import { isAuditOnlyKnowledgeModule } from './audit-only-modules';

function summarizeCardData(data: Record<string, unknown>): string {
  const content = data.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  const hardRules = data.hardRules;
  if (Array.isArray(hardRules) && hardRules.length) {
    return hardRules.map((rule) => `- ${String(rule)}`).join('\n');
  }
  return JSON.stringify(data);
}

export function formatKnowledgeCardsPromptBlock(cards: KnowledgeCard[]): string {
  const promptCards = cards.filter((card) => !isAuditOnlyKnowledgeModule(card.module));
  if (!promptCards.length) return '';
  const lines: string[] = [];
  for (const card of promptCards) {
    lines.push(`- ${card.title} (${card.module}, v${card.version}, priority ${card.priority})`);
    const body = summarizeCardData(card.data);
    if (body) lines.push(body);
  }
  return lines.join('\n');
}

export function formatKnowledgeContextPromptBlock(context: Pick<KnowledgeContextForStage, 'promptBlocks'>): string {
  return context.promptBlocks.filter(Boolean).join('\n\n');
}
