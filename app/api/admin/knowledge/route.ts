import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { dryRunPayload, withAdminAudit } from '@/lib/admin-audit';
import { ensureAdminPreviewUser } from '@/lib/admin-shadow';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { isKnowledgeSelectiveInjectionEnabledForStage } from '@/lib/feature-flags';
import { buildKnowledgeContextForStage } from '@/lib/knowledge/compile-context';
import { isAuditOnlyKnowledgeModule } from '@/lib/knowledge/audit-only-modules';
import { estimatePromptBlockTokens } from '@/lib/knowledge/token-estimate';
import { chatComplete } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODULES = [
  { key: 'style_bible', label: '风格视觉', stage: 'style_bible' },
  { key: 'narrative_structure', label: '剧情结构', stage: 'script_create' },
  { key: 'shot_design', label: '镜头动作', stage: 'shots_generate' },
  { key: 'asset_extraction', label: '素材规范', stage: 'assets_extract' },
  { key: 'identity_consistency', label: '角色一致性', stage: 'assets_extract' },
  { key: 'storyboard_prompt', label: '分镜提示词', stage: 'storyboard_sketch_prompt' },
  { key: 'frame_image', label: '首尾帧图像', stage: 'first_frame_image' },
  { key: 'video_prompt', label: '视频提示词', stage: 'video_prompt' },
  { key: 'video_prompt_refine', label: '提示词精修', stage: 'video_prompt_refine' },
  { key: 'provider_runtime', label: '模型运行规则', stage: 'video_submit' },
  { key: 'edit_strategy', label: '剪辑策略', stage: 'edit_edl' },
  { key: 'audio_subtitle_export', label: '音频字幕导出', stage: 'export' },
] as const;

type AdminKnowledgeModule = (typeof MODULES)[number]['key'];

const STAGES = [
  'script_create',
  'style_bible',
  'assets_extract',
  'shots_generate',
  'storyboard_sketch_prompt',
  'first_frame_image',
  'tail_frame_image',
  'video_prompt',
  'video_prompt_refine',
  'video_submit',
  'edit_analyze',
  'edit_edl',
  'export',
] as const;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch {
    return jsonError('unauthorized', 401);
  }
  const url = new URL(req.url);
  const view = String(url.searchParams.get('view') || 'cards');
  if (view === 'audits') {
    return jsonOk({
      modules: MODULES,
      stages: STAGES,
      projects: listPreviewProjects(),
      ...listKnowledgeAudits(url),
      metrics: listKnowledgeAuditMetrics(),
      generatedAt: new Date().toISOString(),
    });
  }
  if (view === 'audit_detail') {
    const id = String(url.searchParams.get('id') || '').trim();
    const audit = readKnowledgeAudit(id);
    if (!audit) return jsonError('audit not found', 404);
    return jsonOk({ audit, generatedAt: new Date().toISOString() });
  }
  if (view === 'dry_run') {
    return dryRunKnowledgeContext(url);
  }
  const module = normalizeModule(url.searchParams.get('module')) || 'style_bible';
  return jsonOk({
    modules: MODULES,
    stages: STAGES,
    cards: listKnowledgeCards(module),
    projects: listPreviewProjects(),
    selectedModule: module,
    generatedAt: new Date().toISOString(),
  });
}

function listKnowledgeAudits(url: URL) {
  const db = getDb();
  const params: Record<string, unknown> = {};
  const where: string[] = ['1=1'];
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const stage = String(url.searchParams.get('stage') || '').trim();
  const ruleCardId = String(url.searchParams.get('ruleCardId') || '').trim();
  const guardMode = String(url.searchParams.get('guardMode') || '').trim();
  const provider = String(url.searchParams.get('provider') || '').trim();
  const runId = String(url.searchParams.get('runId') || '').trim();
  const from = String(url.searchParams.get('from') || '').trim();
  const to = String(url.searchParams.get('to') || '').trim();
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 100);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);

  if (projectId) {
    where.push('pkc.project_id = @projectId');
    params.projectId = projectId;
  }
  if (stage) {
    where.push('pkc.stage = @stage');
    params.stage = stage;
  }
  if (ruleCardId) {
    where.push(`EXISTS (
      SELECT 1
      FROM json_each(pkc.rule_card_ids_json)
      WHERE value = @ruleCardId
    )`);
    params.ruleCardId = ruleCardId;
  }
  if (guardMode) {
    where.push(`json_extract(pkc.stage_target_json, '$.guardMode') = @guardMode`);
    params.guardMode = guardMode;
  }
  if (provider) {
    where.push('pkc.provider = @provider');
    params.provider = provider;
  }
  if (runId) {
    where.push('pkc.created_by_run_id = @runId');
    params.runId = runId;
  }
  if (from) {
    where.push('pkc.updated_at >= @from');
    params.from = from;
  }
  if (to) {
    where.push('pkc.updated_at <= @to');
    params.to = to;
  }

  const whereSql = where.join(' AND ');
  const rows = db.prepare(
    `SELECT pkc.id,
            pkc.owner_id AS ownerId,
            pkc.project_id AS projectId,
            COALESCE(p.title, pkc.project_id) AS projectTitle,
            u.username,
            pkc.stage,
            pkc.provider,
            pkc.stage_target_json AS stageTargetJson,
            pkc.input_hash AS inputHash,
            pkc.context_hash AS contextHash,
            pkc.rule_card_ids_json AS ruleCardIdsJson,
            pkc.created_by_run_id AS createdByRunId,
            pkc.created_at AS createdAt,
            pkc.updated_at AS updatedAt
       FROM project_knowledge_contexts pkc
       LEFT JOIN projects p ON p.id = pkc.project_id AND p.owner_id = pkc.owner_id
       LEFT JOIN users u ON u.id = pkc.owner_id
      WHERE ${whereSql}
      ORDER BY pkc.updated_at DESC
      LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as any[];
  const totalRow = db.prepare(
    `SELECT COUNT(*) AS count
       FROM project_knowledge_contexts pkc
      WHERE ${whereSql}`,
  ).get(params) as any;
  return {
    audits: rows.map(decodeAuditSummary),
    page: {
      limit,
      offset,
      total: Number(totalRow?.count || 0),
      hasMore: offset + rows.length < Number(totalRow?.count || 0),
    },
  };
}

function listKnowledgeAuditMetrics() {
  const db = getDb();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentRows = db.prepare<{ since: string }, any>(
    `SELECT stage,
            COUNT(*) AS total,
            SUM(CASE
                  WHEN json_extract(context_json, '$.injection.injected') = 1
                   AND json_extract(stage_target_json, '$.accepted') = 0
                  THEN 1 ELSE 0 END) AS injectionRejected,
            SUM(CASE
                  WHEN json_extract(context_json, '$.injection.reason') = 'token_limit_exceeded'
                  THEN 1 ELSE 0 END) AS tokenLimited
       FROM project_knowledge_contexts
      WHERE updated_at >= @since
      GROUP BY stage`,
  ).all({ since });
  const lastRows = db.prepare<[], any>(
    `SELECT stage, MAX(updated_at) AS lastAuditAt
       FROM project_knowledge_contexts
      GROUP BY stage`,
  ).all();
  const recentByStage = new Map(recentRows.map((row) => [row.stage, row]));
  const lastByStage = new Map(lastRows.map((row) => [row.stage, row.lastAuditAt]));
  const criticalStages = new Set(['style_bible', 'video_prompt', 'video_prompt_refine']);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return {
    windowDays: 7,
    retentionNote: '过去 7 天内可用审计样本；高频 stage 受每 owner/project/stage 最近 50 条保留策略影响，可能实际代表最近 50 次运行。',
    stages: STAGES.map((stage) => {
      const row = recentByStage.get(stage) || {};
      const total = Number(row.total || 0);
      const injectionRejected = Number(row.injectionRejected || 0);
      const tokenLimited = Number(row.tokenLimited || 0);
      const injectionRejectRate = total ? injectionRejected / total : 0;
      const tokenLimitRate = total ? tokenLimited / total : 0;
      const lastAuditAt = lastByStage.get(stage) || null;
      const lastMs = lastAuditAt ? Date.parse(String(lastAuditAt)) : 0;
      const noRecentCriticalActivity = criticalStages.has(stage) && (!lastMs || lastMs < dayAgo);
      return {
        stage,
        total,
        injectionRejected,
        injectionRejectRate,
        tokenLimited,
        tokenLimitRate,
        lastAuditAt,
        rejectStatus: rateStatus(injectionRejectRate, 0.05, 0.10),
        tokenStatus: rateStatus(tokenLimitRate, 0.10, 0.25),
        activityStatus: noRecentCriticalActivity ? 'warn' : (lastAuditAt ? 'ok' : 'empty'),
      };
    }),
  };
}

function readKnowledgeAudit(id: string) {
  if (!id) return null;
  const row = getDb().prepare<{ id: string }, any>(
    `SELECT pkc.*,
            p.title AS projectTitle,
            u.username
       FROM project_knowledge_contexts pkc
       LEFT JOIN projects p ON p.id = pkc.project_id AND p.owner_id = pkc.owner_id
       LEFT JOIN users u ON u.id = pkc.owner_id
      WHERE pkc.id = @id`,
  ).get({ id });
  if (!row) return null;
  const context = parseJsonObject(row.context_json);
  const structured = (context as any)?.structured || {};
  const cards = Array.isArray(structured.cards) ? structured.cards : [];
  const injectedCards = Array.isArray(structured.injectedCards)
    ? structured.injectedCards
    : cards.filter((card: any) => !isAuditOnlyKnowledgeModule(card?.module));
  const auditOnlyCards = Array.isArray(structured.auditOnlyCards)
    ? structured.auditOnlyCards
    : cards.filter((card: any) => isAuditOnlyKnowledgeModule(card?.module));
  return {
    id: row.id,
    ownerId: row.owner_id,
    username: row.username || null,
    projectId: row.project_id,
    projectTitle: row.projectTitle || row.project_id,
    stage: row.stage,
    provider: row.provider || null,
    stageTarget: parseJsonObject(row.stage_target_json),
    inputHash: row.input_hash,
    contextHash: row.context_hash,
    promptBlock: row.prompt_block || '',
    sourceHashes: parseJsonArray(row.source_hashes_json),
    ruleCardIds: parseJsonArray(row.rule_card_ids_json),
    createdByRunId: row.created_by_run_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectSnapshot: structured.projectSnapshot || {},
    featureFlagsSnapshot: structured.featureFlagsSnapshot || {},
    injection: (context as any)?.injection || null,
    cards,
    injectedCards,
    auditOnlyCards,
  };
}

function dryRunKnowledgeContext(url: URL) {
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const stage = String(url.searchParams.get('stage') || '').trim();
  const provider = String(url.searchParams.get('provider') || '').trim() || null;
  if (!projectId) return jsonError('projectId required', 400);
  if (!STAGES.includes(stage as any)) return jsonError('stage not allowed', 400);
  const project = readProject(projectId);
  if (!project) return jsonError('project not found', 404);
  const stageTarget = parseJsonObject(url.searchParams.get('stageTargetJson') || '{}');
  const context = buildKnowledgeContextForStage({
    ownerId: Number(project.ownerId),
    project,
    stage: stage as any,
    stageTarget: { ...stageTarget, dryRun: true },
    provider,
    runId: 'admin-dry-run',
  });
  return jsonOk({
    dryRun: {
      project: { id: project.id, title: project.title, ownerId: project.ownerId, username: project.username },
      stage,
      provider,
      injectionEnabled: isKnowledgeSelectiveInjectionEnabledForStage(stage),
      estimatedTokens: estimatePromptBlockTokens(context.promptBlock || ''),
      promptBlock: context.promptBlock || '',
      ruleCards: context.structured.cards.map((card) => ({
        id: card.id,
        module: card.module,
        title: card.title,
        version: card.version,
        priority: card.priority,
        tags: card.tags,
      })),
      generatedAt: new Date().toISOString(),
    },
  });
}

function decodeAuditSummary(row: any) {
  const stageTarget = parseJsonObject(row.stageTargetJson);
  return {
    id: row.id,
    ownerId: row.ownerId,
    username: row.username || null,
    projectId: row.projectId,
    projectTitle: row.projectTitle || row.projectId,
    stage: row.stage,
    provider: row.provider || null,
    guardMode: typeof stageTarget.guardMode === 'string' ? stageTarget.guardMode : null,
    factCounts: stageTarget.factCounts || null,
    violationTypes: Array.isArray(stageTarget.violationTypes) ? stageTarget.violationTypes : [],
    stageTargetSummary: summarizeStageTarget(stageTarget),
    inputHash: row.inputHash,
    contextHash: row.contextHash,
    ruleCardIds: parseJsonArray(row.ruleCardIdsJson),
    createdByRunId: row.createdByRunId || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function summarizeStageTarget(stageTarget: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of ['mode', 'groupIdx', 'shotIndices', 'guardMode', 'accepted', 'provider', 'itemCount', 'clipIds', 'bgmId']) {
    if (stageTarget[key] !== undefined) out[key] = stageTarget[key];
  }
  if (stageTarget.factCounts) out.factCounts = stageTarget.factCounts;
  if (stageTarget.violationTypes) out.violationTypes = stageTarget.violationTypes;
  return out;
}

export const POST = withAdminAudit(async function mutateKnowledge(req: NextRequest, audit) {
  const body = audit.body || {};
  const action = String(body.action || '').trim();
  if (!['save_draft', 'preview', 'publish', 'rollback'].includes(action)) return jsonError('unsupported action', 400);

  if (action === 'save_draft') return handleSaveDraft(audit);
  if (action === 'preview') return handlePreview(audit, req);
  if (action === 'publish') return handlePublish(audit);
  return handleRollback(audit);
}, 'knowledge.mutate', {
  category: 'knowledge',
  supportDryRun: true,
  idempotent: true,
});

function listKnowledgeCards(module: string) {
  return getDb().prepare<any, any>(
    `SELECT kc.id,
            kc.scope,
            kc.owner_id AS ownerId,
            kc.module,
            kc.card_type AS cardType,
            kc.title,
            kc.status,
            kc.lifecycle,
            kc.priority,
            kc.tags_json AS tagsJson,
            kc.data_json AS dataJson,
            kc.source_ref_json AS sourceRefJson,
            kc.schema_version AS schemaVersion,
            kc.version,
            kc.published_at AS publishedAt,
            kc.published_by AS publishedBy,
            au.username AS publishedByUsername,
            kc.previous_version_id AS previousVersionId,
            kc.seeded_at AS seededAt,
            kc.created_at AS createdAt,
            kc.updated_at AS updatedAt
       FROM knowledge_cards kc
       LEFT JOIN admin_users au ON au.id = kc.published_by
      WHERE kc.module = @module
      ORDER BY
        CASE kc.lifecycle WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
        kc.priority ASC,
        kc.version DESC,
        kc.updated_at DESC
      LIMIT 200`,
  ).all({ module }).map(decodeCardRow);
}

function listPreviewProjects() {
  return getDb().prepare<[], any>(
    `SELECT p.id, p.owner_id AS ownerId, u.username, p.title, p.updated_at AS updatedAt
       FROM projects p
       JOIN users u ON u.id = p.owner_id
      WHERE u.username NOT LIKE '__shadow__%'
      ORDER BY p.updated_at DESC
      LIMIT 80`,
  ).all();
}

function handleSaveDraft(audit: any) {
  const body = audit.body || {};
  const module = normalizeModule(body.module);
  if (!module) return jsonError('module not allowed in P1 knowledge admin', 400);
  const title = String(body.title || '').trim().slice(0, 160);
  if (!title) return jsonError('title required', 400);
  const cardType = String(body.cardType || 'rule').trim().slice(0, 80) || 'rule';
  const data = parseJsonObject(body.dataJson ?? body.data);
  const tags = normalizeTags(Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(','));
  const priority = clampInt(body.priority, 100, 1, 9999);
  const existing = body.id ? readCard(String(body.id)) : null;
  if (existing && existing.lifecycle !== 'draft') return jsonError('only draft card can be edited', 409);
  const before = existing || null;
  const id = existing?.id || `admin-draft-${randomUUID()}`;
  const after = {
    id,
    scope: 'system',
    ownerId: null,
    module,
    cardType,
    title,
    status: 'active',
    lifecycle: 'draft',
    priority,
    tags,
    data,
    sourceRef: { adminDraft: true },
    schemaVersion: 1,
    version: existing?.version || nextVersionFor(module, title),
  };
  audit.setAuditTarget({ type: 'knowledge_card', ids: [id] });
  audit.setAuditDiff({ before, after });
  if (audit.dryRun) return jsonOk(dryRunPayload('knowledge.save_draft', { type: 'knowledge_card', ids: [id] }, { before, after }));

  getDb().prepare(
    `INSERT INTO knowledge_cards
      (id, owner_id, scope, module, card_type, title, status, lifecycle, priority,
       tags_json, data_json, source_ref_json, schema_version, version, created_at, updated_at)
     VALUES
      (@id, NULL, 'system', @module, @cardType, @title, 'active', 'draft', @priority,
       @tagsJson, @dataJson, @sourceRefJson, 1, @version, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(id) DO UPDATE SET
       card_type = excluded.card_type,
       title = excluded.title,
       priority = excluded.priority,
       tags_json = excluded.tags_json,
       data_json = excluded.data_json,
       source_ref_json = excluded.source_ref_json,
       updated_at = excluded.updated_at
     WHERE knowledge_cards.lifecycle = 'draft'`,
  ).run({
    id,
    module,
    cardType,
    title,
    priority,
    tagsJson: JSON.stringify(tags),
    dataJson: JSON.stringify(data),
    sourceRefJson: JSON.stringify(after.sourceRef),
    version: after.version,
  });
  return jsonOk({ success: true, action: 'save_draft', card: readCard(id) });
}

async function handlePreview(audit: any, req: NextRequest) {
  const body = audit.body || {};
  const cardId = String(body.cardId || body.id || '').trim();
  const projectId = String(body.projectId || '').trim();
  const card = readCard(cardId);
  if (!card) return jsonError('card not found', 404);
  if (card.lifecycle !== 'draft') return jsonError('preview requires a draft card', 409);
  const module = normalizeModule(card.module);
  if (!module) return jsonError('module not allowed in P1 knowledge admin', 400);
  const project = readProject(projectId);
  if (!project) return jsonError('project not found', 404);

  const shadowUserId = ensurePreviewUserForAdmin(audit.admin.id);
  const before = { card, project: { id: project.id, title: project.title }, shadowUserId };
  audit.setAuditTarget({ type: 'knowledge_card', ids: [cardId] });
  audit.setAuditDiff({ before, after: { preview: true, chargedUserId: shadowUserId } });
  if (audit.dryRun) {
    return jsonOk(dryRunPayload('knowledge.preview', { type: 'knowledge_card', ids: [cardId] }, {
      before,
      after: { preview: true, chargedUserId: shadowUserId, runModel: body.runModel !== false },
    }));
  }

  const prompt = buildPreviewPrompt({ card, project, module });
  let output = '';
  let mode = 'model';
  if (body.runModel === false) {
    mode = 'context_only';
    output = localPreviewOutput(card, project);
  } else {
    const shadowUser = getDb().prepare<{ id: number }, any>('SELECT * FROM users WHERE id = @id').get({ id: shadowUserId });
    output = await chatComplete(shadowUser || null, [
      { role: 'system', content: '你是 ORIGINRISE 管理后台的知识卡预览器。请用极短样本说明这张规则卡会如何影响生成，不要写长文。' },
      { role: 'user', content: prompt },
    ], {
      maxTokens: 500,
      temperature: 0.2,
      modelRole: 'structured',
      traceName: 'admin.knowledge.preview',
      requestTimeoutMs: 60_000,
      tokenContext: {
        projectId,
        projectTitleSnapshot: project.title || null,
        requestPath: req.nextUrl.pathname,
        routeName: 'admin.knowledge.preview',
        moduleKey: 'knowledge',
        moduleLabel: '知识库',
        featureKey: 'knowledge_preview',
        featureLabel: '知识卡预览',
        callItemType: 'knowledge_card',
        callItemId: cardId,
        callItemLabel: card.title || cardId,
          runId: audit.idempotencyKey || null,
          billingScope: 'internal_admin',
          operationKey: `admin-preview:${audit.idempotencyKey || cardId}`,
          operationLabel: '知识卡预览',
          meta: {
          adminId: audit.admin?.id || null,
          adminUsername: audit.admin?.username || null,
          previewProjectOwnerId: project.ownerId || null,
        },
      },
    });
  }

  return jsonOk({
    success: true,
    action: 'preview',
    mode,
    cardId,
    projectId,
    charged: 0,
    prompt,
    output,
  });
}

function handlePublish(audit: any) {
  const cardId = String(audit.body?.cardId || audit.body?.id || '').trim();
  const draft = readCard(cardId);
  if (!draft) return jsonError('draft not found', 404);
  if (draft.lifecycle !== 'draft') return jsonError('only draft cards can be published', 409);
  if (!hasPreviewAudit(cardId)) return jsonError('publish requires a completed preview audit first', 409);
  const before = { draft, current: currentPublishedFor(draft.module, draft.title) };
  const after = {
    ...draft,
    id: `admin-published-${randomUUID()}`,
    lifecycle: 'published',
    status: 'active',
    version: Math.max(Number(draft.version || 1), nextVersionFor(draft.module, draft.title)),
    publishedBy: audit.admin.id,
    publishedAt: new Date().toISOString(),
    previousVersionId: before.current?.id || draft.previousVersionId || null,
  };
  audit.setAuditTarget({ type: 'knowledge_card', ids: [cardId] });
  audit.setAuditDiff({ before, after });
  if (audit.dryRun) return jsonOk(dryRunPayload('knowledge.publish', { type: 'knowledge_card', ids: [cardId] }, { before, after }));

  const result = publishSnapshot(draft, after, audit.admin.id);
  return jsonOk({ success: true, action: 'publish', card: readCard(result.publishedId), archived: result.archived });
}

function handleRollback(audit: any) {
  const cardId = String(audit.body?.cardId || audit.body?.id || '').trim();
  const source = readCard(cardId);
  if (!source) return jsonError('source card not found', 404);
  if (!['published', 'archived'].includes(String(source.lifecycle))) return jsonError('rollback source must be published/archived history', 409);
  const current = currentPublishedFor(source.module, source.title);
  const after = {
    ...source,
    id: `admin-rollback-${randomUUID()}`,
    lifecycle: 'published',
    status: 'active',
    version: nextVersionFor(source.module, source.title),
    publishedBy: audit.admin.id,
    publishedAt: new Date().toISOString(),
    previousVersionId: current?.id || null,
  };
  audit.setAuditTarget({ type: 'knowledge_card', ids: [cardId] });
  audit.setAuditDiff({ before: { source, current }, after });
  if (audit.dryRun) return jsonOk(dryRunPayload('knowledge.rollback', { type: 'knowledge_card', ids: [cardId] }, { before: { source, current }, after }));

  const result = publishSnapshot(source, after, audit.admin.id);
  return jsonOk({ success: true, action: 'rollback', card: readCard(result.publishedId), archived: result.archived });
}

function publishSnapshot(source: any, next: any, adminId: number) {
  const db = getDb();
  const txn = db.transaction(() => {
    const archived = db.prepare(
      `UPDATE knowledge_cards
          SET lifecycle = 'archived',
              status = 'archived',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE module = @module
          AND title = @title
          AND scope = @scope
          AND COALESCE(owner_id, -1) = COALESCE(@ownerId, -1)
          AND lifecycle = 'published'`,
    ).run({ module: source.module, title: source.title, scope: source.scope, ownerId: source.ownerId }).changes;
    db.prepare(
      `INSERT INTO knowledge_cards
        (id, owner_id, scope, module, card_type, title, status, lifecycle, priority,
         tags_json, data_json, source_ref_json, schema_version, version, published_at, published_by,
         previous_version_id, created_at, updated_at)
       VALUES
        (@id, @ownerId, @scope, @module, @cardType, @title, 'active', 'published', @priority,
         @tagsJson, @dataJson, @sourceRefJson, @schemaVersion, @version, strftime('%Y-%m-%dT%H:%M:%fZ','now'), @adminId,
         @previousVersionId, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run({
      id: next.id,
      ownerId: source.ownerId,
      scope: source.scope,
      module: source.module,
      cardType: source.cardType,
      title: source.title,
      priority: source.priority,
      tagsJson: JSON.stringify(source.tags || []),
      dataJson: JSON.stringify(source.data || {}),
      sourceRefJson: JSON.stringify({ ...(source.sourceRef || {}), publishedFrom: source.id }),
      schemaVersion: source.schemaVersion || 1,
      version: next.version,
      adminId,
      previousVersionId: next.previousVersionId || null,
    });
    return { publishedId: next.id, archived };
  });
  return txn.immediate();
}

function readCard(id: string) {
  const row = getDb().prepare<{ id: string }, any>('SELECT * FROM knowledge_cards WHERE id = @id').get({ id });
  return row ? decodeCardRow({
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    module: row.module,
    cardType: row.card_type,
    title: row.title,
    status: row.status,
    lifecycle: row.lifecycle,
    priority: row.priority,
    tagsJson: row.tags_json,
    dataJson: row.data_json,
    sourceRefJson: row.source_ref_json,
    schemaVersion: row.schema_version,
    version: row.version,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    previousVersionId: row.previous_version_id,
    seededAt: row.seeded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) : null;
}

function currentPublishedFor(module: string, title: string) {
  const row = getDb().prepare<{ module: string; title: string }, any>(
    `SELECT * FROM knowledge_cards
      WHERE module = @module
        AND title = @title
        AND lifecycle = 'published'
        AND status = 'active'
      ORDER BY version DESC, published_at DESC, updated_at DESC
      LIMIT 1`,
  ).get({ module, title });
  return row ? readCard(row.id) : null;
}

function nextVersionFor(module: string, title: string) {
  const row = getDb().prepare<{ module: string; title: string }, any>(
    `SELECT MAX(version) AS version FROM knowledge_cards WHERE module = @module AND title = @title`,
  ).get({ module, title });
  return Number(row?.version || 0) + 1;
}

function hasPreviewAudit(cardId: string) {
  const row = getDb().prepare<{ cardId: string }, any>(
    `SELECT id FROM admin_actions
      WHERE action = 'knowledge.mutate'
        AND target_type = 'knowledge_card'
        AND target_id = @cardId
        AND dry_run = 0
        AND status = 'completed'
        AND response_status BETWEEN 200 AND 299
        AND result_json LIKE '%"action":"preview"%'
      ORDER BY created_at DESC
      LIMIT 1`,
  ).get({ cardId });
  return !!row;
}

function readProject(projectId: string) {
  const row = getDb().prepare<{ id: string }, any>(
    `SELECT p.*, u.username
       FROM projects p
       JOIN users u ON u.id = p.owner_id
      WHERE p.id = @id`,
  ).get({ id: projectId });
  if (!row) return null;
  let data: any = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch {}
  return {
    id: row.id,
    ownerId: row.owner_id,
    username: row.username,
    title: row.title,
    description: row.description,
    status: row.status,
    ...data,
  };
}

function ensurePreviewUserForAdmin(adminId: number) {
  const db = getDb();
  const admin = db.prepare<{ id: number }, any>(
    'SELECT id, username, preview_user_id FROM admin_users WHERE id = @id',
  ).get({ id: adminId });
  if (!admin) throw new Error('admin not found');
  return ensureAdminPreviewUser(db, admin);
}

function buildPreviewPrompt(args: { card: any; project: any; module: AdminKnowledgeModule }) {
  const context = buildKnowledgeContextForStage({
    ownerId: Number(args.project.ownerId),
    project: args.project,
    stage: moduleStage(args.module) as any,
    stageTarget: { adminPreview: true, draftCardId: args.card.id },
    provider: null,
    runId: `admin-preview-${args.card.id}`,
  });
  return [
    `项目：${args.project.title || args.project.id}`,
    `模块：${args.module}`,
    `草稿卡片：${args.card.title} v${args.card.version}`,
    `草稿规则：${JSON.stringify(args.card.data, null, 2)}`,
    context.promptBlock ? `当前已发布规则上下文：\n${context.promptBlock}` : '当前已发布规则上下文：无',
    '请输出一个 3-5 行短样本，展示这张草稿规则发布后对生成行为的影响。',
  ].join('\n\n');
}

function localPreviewOutput(card: any, project: any) {
  return [
    `[context-only preview] ${card.title}`,
    `项目：${project.title || project.id}`,
    `模块：${card.module}`,
    `规则摘要：${JSON.stringify(card.data).slice(0, 500)}`,
  ].join('\n');
}

function decodeCardRow(row: any) {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.ownerId ?? row.owner_id ?? null,
    module: row.module,
    cardType: row.cardType ?? row.card_type,
    title: row.title,
    status: row.status,
    lifecycle: row.lifecycle || 'published',
    priority: Number(row.priority || 100),
    tags: parseJsonArray(row.tagsJson ?? row.tags_json),
    data: parseJsonObject(row.dataJson ?? row.data_json),
    sourceRef: parseJsonObject(row.sourceRefJson ?? row.source_ref_json),
    schemaVersion: Number(row.schemaVersion ?? row.schema_version ?? 1),
    version: Number(row.version || 1),
    publishedAt: row.publishedAt ?? row.published_at ?? null,
    publishedBy: row.publishedBy ?? row.published_by ?? null,
    publishedByUsername: row.publishedByUsername ?? null,
    previousVersionId: row.previousVersionId ?? row.previous_version_id ?? null,
    seededAt: row.seededAt ?? row.seeded_at ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

function normalizeModule(value: unknown): AdminKnowledgeModule | '' {
  const module = String(value || '').trim();
  return MODULES.some((item) => item.key === module) ? module as AdminKnowledgeModule : '';
}

function moduleStage(module: AdminKnowledgeModule) {
  return MODULES.find((item) => item.key === module)?.stage || 'style_bible';
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeTags(tags: unknown[]): string[] {
  return Array.from(new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))).sort();
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function rateStatus(rate: number, warnAt: number, dangerAt: number) {
  if (rate > dangerAt) return 'danger';
  if (rate >= warnAt) return 'warn';
  return 'ok';
}
