import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import type { KnowledgeContextForStage, ProjectKnowledgeContextRow } from './types';

type ProjectKnowledgeContextDbRow = {
  id: string;
  owner_id: number;
  project_id: string;
  stage: string;
  provider: string | null;
  stage_target_json: string;
  input_hash: string;
  context_hash: string;
  context_json: string;
  prompt_block: string | null;
  source_hashes_json: string;
  rule_card_ids_json: string;
  created_by_run_id: string | null;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toContextRow(row: ProjectKnowledgeContextDbRow): ProjectKnowledgeContextRow {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    stage: row.stage,
    provider: row.provider || null,
    stageTarget: parseJson(row.stage_target_json, {}),
    inputHash: row.input_hash,
    contextHash: row.context_hash,
    context: parseJson(row.context_json, {} as KnowledgeContextForStage),
    promptBlock: row.prompt_block,
    sourceHashes: parseJson(row.source_hashes_json, []),
    ruleCardIds: parseJson(row.rule_card_ids_json, []),
    createdByRunId: row.created_by_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertProjectKnowledgeContext(input: {
  ownerId: number;
  projectId: string;
  context: KnowledgeContextForStage;
  runId?: string | null;
}): ProjectKnowledgeContextRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const provider = String(input.context.structured?.featureFlagsSnapshot?.provider || '').trim() || null;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO project_knowledge_contexts
         (id, owner_id, project_id, stage, provider, stage_target_json, input_hash, context_hash,
          context_json, prompt_block, source_hashes_json, rule_card_ids_json, created_by_run_id, created_at, updated_at)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, project_id, stage, input_hash) DO UPDATE SET
         updated_at = excluded.updated_at,
         provider = excluded.provider,
         stage_target_json = excluded.stage_target_json,
         context_json = excluded.context_json,
         created_by_run_id = excluded.created_by_run_id,
         rule_card_ids_json = excluded.rule_card_ids_json`,
    ).run(
      id,
      input.ownerId,
      input.projectId,
      input.context.stage,
      provider,
      JSON.stringify(input.context.stageTarget || {}),
      input.context.inputHash,
      input.context.contextHash,
      JSON.stringify(input.context),
      input.context.promptBlock || null,
      JSON.stringify(input.context.sourceHashes || []),
      JSON.stringify(input.context.ruleCardIds || []),
      input.runId || null,
      now,
      now,
    );

    db.prepare(
      `DELETE FROM project_knowledge_contexts
       WHERE owner_id = ?
         AND project_id = ?
         AND stage = ?
         AND id NOT IN (
           SELECT id FROM project_knowledge_contexts
           WHERE owner_id = ?
             AND project_id = ?
             AND stage = ?
           ORDER BY updated_at DESC
           LIMIT 50
         )`,
    ).run(input.ownerId, input.projectId, input.context.stage, input.ownerId, input.projectId, input.context.stage);

    return db
      .prepare(
        `SELECT * FROM project_knowledge_contexts
         WHERE owner_id = ?
           AND project_id = ?
           AND stage = ?
           AND input_hash = ?`,
      )
      .get(input.ownerId, input.projectId, input.context.stage, input.context.inputHash) as ProjectKnowledgeContextDbRow;
  });
  return toContextRow(tx());
}

export function recordKnowledgeContextBestEffort(input: {
  ownerId: number;
  projectId: string;
  context: KnowledgeContextForStage;
  runId?: string | null;
}): ProjectKnowledgeContextRow | null {
  try {
    return upsertProjectKnowledgeContext(input);
  } catch (error) {
    console.warn('[knowledge] failed to record project knowledge context:', error);
    return null;
  }
}
