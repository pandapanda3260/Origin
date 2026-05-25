import { getDb } from '../lib/db';
import {
  listTokenUsageEvents,
  recordTokenUsageEvent,
  summarizeTokenUsage,
  summarizeTokenUsageByCategory,
  summarizeTokenUsageByUser,
} from '../lib/token-usage';
import type { ResolvedModelConfig } from '../lib/model-routing';

const db = getDb();
const marker = `smoke-token-usage-${Date.now()}`;

const cfg: ResolvedModelConfig = {
  baseUrl: 'http://localhost',
  apiKey: 'smoke',
  model: 'smoke-model',
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  mode: 'real',
  source: 'env',
  provider: 'openai_chat',
  role: 'brain',
};

const id = recordTokenUsageEvent({
  cfg,
  slot: 'brain',
  modelRole: 'brain',
  traceName: 'smoke-token-usage',
  status: 'ok',
  latencyMs: 12,
  usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 3, totalTokens: 33 },
  tokenContext: {
    ownerId: null,
    usernameSnapshot: 'smoke',
    projectId: marker,
    projectTitleSnapshot: 'Smoke Token Usage',
    moduleKey: 'smoke',
    moduleLabel: 'Smoke',
    featureKey: 'smoke_call',
    featureLabel: 'Smoke Call',
    callItemType: 'test',
    callItemId: marker,
    callItemLabel: 'smoke event',
  },
});

if (!id) throw new Error('recordTokenUsageEvent returned null');

try {
  const stored = db
    .prepare('SELECT id, total_tokens AS totalTokens, usage_source AS usageSource FROM token_usage_events WHERE id = ?')
    .get(id) as { id: string; totalTokens: number; usageSource: string } | undefined;
  if (!stored || stored.totalTokens !== 33 || stored.usageSource !== 'provider') {
    throw new Error(`unexpected stored token event: ${JSON.stringify(stored)}`);
  }

  const since = new Date(Date.now() - 60_000).toISOString();
  const summary = summarizeTokenUsage({ since, projectId: marker });
  if (summary.totalTokens < 33 || summary.calls < 1) {
    throw new Error(`unexpected summary: ${JSON.stringify(summary)}`);
  }

  const byUser = summarizeTokenUsageByUser({ since, projectId: marker });
  if (!byUser.length || byUser[0].totalTokens < 33) {
    throw new Error(`unexpected user summary: ${JSON.stringify(byUser)}`);
  }

  const byCategory = summarizeTokenUsageByCategory({ since, projectId: marker });
  if (!byCategory.length || byCategory[0].moduleKey !== 'smoke') {
    throw new Error(`unexpected category summary: ${JSON.stringify(byCategory)}`);
  }

  const details = listTokenUsageEvents({ since, projectId: marker, limit: 10 });
  if (!details.rows.some((row) => row.id === id)) {
    throw new Error(`event missing from listTokenUsageEvents: ${JSON.stringify(details)}`);
  }

  console.log('[smoke-admin-token-usage] ok');
} finally {
  db.prepare('DELETE FROM token_usage_events WHERE id = ? OR project_id = ?').run(id, marker);
}
