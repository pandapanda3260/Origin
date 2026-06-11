import { randomUUID } from 'node:crypto';
import { getDb, type UserRow } from './db';
import { chatCompleteJsonWithRetry, parseJsonLoose, type ChatMessage } from './llm';
import { resolveTextModelConfig } from './model-routing';
import { getWorldTemplate } from './world-templates-db';
import type { TokenUsageContext } from './token-usage';

type StyleTemplateRow = {
  id: string;
  owner_id: number | null;
  name: string;
  category: string;
  summary: string;
  data_json: string;
  source: string;
  created_at: string;
  updated_at: string;
};

type MappingRow = {
  world_template_owner_id: number;
  world_template_id: string;
  style_template_id: string;
};

export const FEATURED_STYLE_TEMPLATE_IDS = [
  'style_live_action_realistic',
  'style_3d_xuanhuan',
  'style_live_action_costume',
  'style_3d_realistic',
  'style_2d_animation',
  'style_2d_movie',
  'style_hollywood_blockbuster',
] as const;

type FeaturedStyleTemplateId = typeof FEATURED_STYLE_TEMPLATE_IDS[number];

export const STYLE_AUTO_RECOMMENDATION_VERSION = '2026-06-06-world-preferred-style-v1';

type WeightedTerm = string | [string, number];

type StyleScoreCard = {
  id: FeaturedStyleTemplateId;
  score: number;
  hits: string[];
};

type LLMStyleTemplateDecision = {
  id: FeaturedStyleTemplateId;
  confidence: number;
  reason: string;
  evidence: string[];
};

function cleanId(value: any, fallbackPrefix = 'style') {
  const id = String(value || '').trim();
  if (id && id.length <= 100 && /^[A-Za-z0-9_.:-]+$/.test(id)) return id;
  return `${fallbackPrefix}_${randomUUID()}`;
}

function cleanString(value: any, max: number) {
  return String(value ?? '').trim().slice(0, max);
}

function parseData(row: StyleTemplateRow) {
  try { return JSON.parse(row.data_json || '{}'); } catch { return {}; }
}

function normalizeTemplateInput(input: any, forced: { ownerId: number | null; source: 'system' | 'user' }) {
  const raw = input && typeof input === 'object' ? input : {};
  const id = cleanId(raw.id);
  const name = cleanString(raw.name || raw.title || '未命名风格模板', 120) || '未命名风格模板';
  const category = cleanString(raw.category || '', 120);
  const summary = cleanString(raw.summary || raw.description || '', 500);
  const data = {
    ...raw,
    id,
    name,
    category,
    summary,
    source: forced.source,
    ownerId: forced.ownerId,
  };
  delete data.owner_id;
  return { id, name, category, summary, data, ownerId: forced.ownerId, source: forced.source };
}

function rowToPublic(row: StyleTemplateRow) {
  const data = parseData(row);
  return {
    ...data,
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    category: row.category || data.category || '',
    summary: row.summary || data.summary || '',
    source: row.source || data.source || 'user',
    createdAt: data.createdAt || row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listStyleTemplates(userId: number) {
  const rows = getDb()
    .prepare<{ uid: number }, StyleTemplateRow>(
      `SELECT * FROM style_templates
       WHERE source = 'system' OR owner_id = @uid
       ORDER BY CASE WHEN source = 'system' THEN 0 ELSE 1 END, updated_at DESC, name ASC`,
    )
    .all({ uid: userId });
  return rows.map(rowToPublic);
}

export function getStyleTemplateForUser(userId: number, id: string) {
  const row = getDb()
    .prepare<{ id: string; uid: number }, StyleTemplateRow>(
      `SELECT * FROM style_templates
       WHERE id = @id AND (source = 'system' OR owner_id = @uid)
       LIMIT 1`,
    )
    .get({ id, uid: userId });
  return row ? rowToPublic(row) : null;
}

export function listFeaturedStyleTemplates(userId: number) {
  const byId = new Map(listStyleTemplates(userId).map((tpl: any) => [String(tpl.id || ''), tpl]));
  return FEATURED_STYLE_TEMPLATE_IDS
    .map((id) => byId.get(id))
    .filter(Boolean);
}

function getStyleTemplateRow(id: string) {
  return getDb()
    .prepare<{ id: string }, StyleTemplateRow>('SELECT * FROM style_templates WHERE id = @id LIMIT 1')
    .get({ id });
}

export function createUserStyleTemplate(userId: number, input: any) {
  const tpl = normalizeTemplateInput(input, { ownerId: userId, source: 'user' });
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO style_templates
         (id, owner_id, name, category, summary, data_json, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)`,
    )
    .run(tpl.id, userId, tpl.name, tpl.category, tpl.summary, JSON.stringify(tpl.data), now, now);
  return getStyleTemplateForUser(userId, tpl.id)!;
}

export function updateUserStyleTemplate(userId: number, id: string, input: any) {
  const row = getStyleTemplateRow(id);
  if (!row) return { error: 'not_found' as const };
  if (row.source === 'system' || row.owner_id !== userId) return { error: 'forbidden' as const };

  const current = rowToPublic(row);
  const raw = input && typeof input === 'object' ? input : {};
  const name = cleanString(raw.name ?? current.name, 120) || current.name;
  const category = cleanString(raw.category ?? current.category, 120);
  const summary = cleanString(raw.summary ?? current.summary, 500);
  const data = {
    ...current,
    ...raw,
    id,
    name,
    category,
    summary,
    source: 'user',
    ownerId: userId,
  };
  delete data.owner_id;
  getDb()
    .prepare(
      `UPDATE style_templates
       SET name = ?, category = ?, summary = ?, data_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND owner_id = ?`,
    )
    .run(name, category, summary, JSON.stringify(data), id, userId);
  return { template: getStyleTemplateForUser(userId, id)! };
}

export function deleteUserStyleTemplate(userId: number, id: string) {
  const row = getStyleTemplateRow(id);
  if (!row) return { error: 'not_found' as const };
  if (row.source === 'system' || row.owner_id !== userId) return { error: 'forbidden' as const };
  getDb().prepare('DELETE FROM style_templates WHERE id = ? AND owner_id = ?').run(id, userId);
  return { ok: true as const };
}

function normalizeWorldOwnerId(userId: number, value: any) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : userId;
}

function preferredStyleTemplateIdFromWorld(value: any) {
  const preference = value?.styleTemplatePreference;
  return cleanString(
    value?.preferredStyleTemplateId
      || value?.preferred_style_template_id
      || preference?.styleTemplateId
      || preference?.templateId
      || preference?.id
      || '',
    100,
  );
}

function preferredStyleTemplateNameFromWorld(value: any) {
  const preference = value?.styleTemplatePreference;
  return cleanString(
    value?.preferredStyleTemplateName
      || value?.preferred_style_template_name
      || preference?.styleTemplateName
      || preference?.name
      || preference?.title
      || '',
    120,
  );
}

function resolvePreferredWorldStyleTemplate(userId: number, worldTemplateSnapshot: any, scriptKey?: string) {
  const preferredStyleTemplateId = preferredStyleTemplateIdFromWorld(worldTemplateSnapshot);
  if (!preferredStyleTemplateId) return null;
  const styleTemplate = getStyleTemplateForUser(userId, preferredStyleTemplateId);
  if (!styleTemplate) return null;
  const name = preferredStyleTemplateNameFromWorld(worldTemplateSnapshot) || cleanString((styleTemplate as any).name || '', 120);
  return {
    source: 'world_preferred' as const,
    decisionSource: 'world_preferred' as const,
    styleTemplate,
    reason: name ? `世界观关联风格模板「${name}」` : '世界观关联风格模板',
    ...(scriptKey ? { scriptKey } : {}),
  };
}

function assertWorldTemplateExists(worldOwnerId: number, worldTemplateId: string) {
  const row = getDb()
    .prepare<{ owner: number; id: string }, { id: string }>(
      'SELECT id FROM world_templates WHERE owner_id = @owner AND id = @id LIMIT 1',
    )
    .get({ owner: worldOwnerId, id: worldTemplateId });
  return !!row;
}

export function setDefaultWorldStyleMapping(opts: {
  worldTemplateOwnerId: number;
  worldTemplateId: string;
  styleTemplateId: string;
}) {
  const worldTemplateId = cleanString(opts.worldTemplateId, 100);
  const styleTemplateId = cleanString(opts.styleTemplateId, 100);
  if (!worldTemplateId || !styleTemplateId) return { error: 'invalid' as const };
  if (!assertWorldTemplateExists(opts.worldTemplateOwnerId, worldTemplateId)) return { error: 'world_not_found' as const };
  const style = getStyleTemplateRow(styleTemplateId);
  if (!style) return { error: 'style_not_found' as const };
  if (style.source !== 'system') return { error: 'style_not_system' as const };

  const db = getDb();
  const id = cleanId(`default_${opts.worldTemplateOwnerId}_${worldTemplateId}_${styleTemplateId}`, 'map');
  db.transaction(() => {
    db.prepare(
      `UPDATE world_style_default_mappings
       SET is_default = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE world_template_owner_id = ? AND world_template_id = ? AND is_default = 1`,
    ).run(opts.worldTemplateOwnerId, worldTemplateId);
    db.prepare(
      `INSERT INTO world_style_default_mappings
         (id, world_template_owner_id, world_template_id, style_template_id, is_default)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         style_template_id = excluded.style_template_id,
         is_default = 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(id, opts.worldTemplateOwnerId, worldTemplateId, styleTemplateId);
  })();
  return { ok: true as const };
}

export function setRecentWorldStyleMapping(userId: number, opts: {
  worldTemplateOwnerId?: number;
  worldTemplateId: string;
  styleTemplateId: string;
}) {
  const worldTemplateOwnerId = normalizeWorldOwnerId(userId, opts.worldTemplateOwnerId);
  const worldTemplateId = cleanString(opts.worldTemplateId, 100);
  const styleTemplateId = cleanString(opts.styleTemplateId, 100);
  if (!worldTemplateId || !styleTemplateId) return { error: 'invalid' as const };
  if (!assertWorldTemplateExists(worldTemplateOwnerId, worldTemplateId)) return { error: 'world_not_found' as const };
  if (!getStyleTemplateForUser(userId, styleTemplateId)) return { error: 'style_not_found' as const };

  getDb()
    .prepare(
      `INSERT INTO user_world_style_recent_mappings
         (user_id, world_template_owner_id, world_template_id, style_template_id, last_used_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, world_template_owner_id, world_template_id) DO UPDATE SET
         style_template_id = excluded.style_template_id,
         last_used_at = excluded.last_used_at`,
    )
    .run(userId, worldTemplateOwnerId, worldTemplateId, styleTemplateId, new Date().toISOString());
  return { ok: true as const };
}

function getRecentMapping(userId: number, worldOwnerId: number, worldTemplateId: string) {
  return getDb()
    .prepare<{ uid: number; owner: number; id: string }, MappingRow>(
      `SELECT world_template_owner_id, world_template_id, style_template_id
       FROM user_world_style_recent_mappings
       WHERE user_id = @uid AND world_template_owner_id = @owner AND world_template_id = @id
       LIMIT 1`,
    )
    .get({ uid: userId, owner: worldOwnerId, id: worldTemplateId });
}

function getDefaultMapping(worldOwnerId: number, worldTemplateId: string) {
  return getDb()
    .prepare<{ owner: number; id: string }, MappingRow>(
      `SELECT world_template_owner_id, world_template_id, style_template_id
       FROM world_style_default_mappings
       WHERE world_template_owner_id = @owner AND world_template_id = @id AND is_default = 1
       LIMIT 1`,
    )
    .get({ owner: worldOwnerId, id: worldTemplateId });
}

export function recommendStyleTemplateForWorld(userId: number, input: {
  worldTemplateId: string;
  worldTemplateOwnerId?: number;
}) {
  const worldTemplateId = cleanString(input.worldTemplateId, 100);
  const worldTemplateOwnerId = normalizeWorldOwnerId(userId, input.worldTemplateOwnerId);
  if (!worldTemplateId) return { source: 'none' as const, styleTemplate: null };

  const worldTemplate = getWorldTemplate(worldTemplateOwnerId, worldTemplateId);
  const preferred = resolvePreferredWorldStyleTemplate(userId, worldTemplate);
  if (preferred) return preferred;

  const recent = getRecentMapping(userId, worldTemplateOwnerId, worldTemplateId);
  if (recent) {
    const styleTemplate = getStyleTemplateForUser(userId, recent.style_template_id);
    if (styleTemplate) return { source: 'user_recent' as const, styleTemplate };
  }

  const globalDefault = getDefaultMapping(worldTemplateOwnerId, worldTemplateId);
  if (globalDefault) {
    const styleTemplate = getStyleTemplateForUser(userId, globalDefault.style_template_id);
    if (styleTemplate) return { source: 'global_default' as const, styleTemplate };
  }

  return { source: 'none' as const, styleTemplate: null };
}

function normalizeRecommendationText(...values: any[]) {
  return values
    .map((value) => String(value ?? ''))
    .join('\n')
    .normalize('NFKC')
    .toLowerCase();
}

export function computeStyleTemplateAutoScriptKey(input: {
  script?: string;
  selectedWorldTemplateId?: any;
  worldTemplateSnapshot?: any;
}) {
  const world = input.worldTemplateSnapshot || {};
  const seed = [
    STYLE_AUTO_RECOMMENDATION_VERSION,
    String(input.script || ''),
    String(input.selectedWorldTemplateId || ''),
    String(world.updatedAt || world.updated_at || ''),
    String(world.id || world.templateId || world.template_id || ''),
    preferredStyleTemplateIdFromWorld(world),
    preferredStyleTemplateNameFromWorld(world),
  ].join('\n');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return `${seed.length}:${Math.abs(hash).toString(36)}`;
}

export function getRecordedStyleTemplateRecommendation(userId: number, project: any, input: {
  script?: string;
  worldTemplateSnapshot?: any;
} = {}) {
  if (!project || typeof project !== 'object') return null;
  const styleOptions = project.styleOptions || {};
  const mode = String(styleOptions.styleTemplateSelectionMode || '').trim();
  const selectedId = cleanString(
    project.selectedStyleTemplateId
      || styleOptions.autoStyleTemplateId
      || project.styleTemplateSnapshot?.id
      || project.styleTemplateSnapshot?.templateId
      || project.styleTemplateSnapshot?.template_id
      || '',
    100,
  );
  const script = String(input.script ?? project.script ?? '');
  const worldTemplateSnapshot = input.worldTemplateSnapshot || project.worldTemplateSnapshot || null;
  const scriptKey = computeStyleTemplateAutoScriptKey({
    script,
    selectedWorldTemplateId: project.selectedWorldTemplateId || '',
    worldTemplateSnapshot,
  });

  if (mode === 'manual' || mode === 'manual_clear') {
    return {
      source: 'manual' as const,
      decisionSource: 'cached_manual' as const,
      styleTemplate: selectedId ? getStyleTemplateForUser(userId, selectedId) : null,
      reason: mode === 'manual_clear' ? '用户已清除风格选择，跳过自动判断' : '用户已手动选择风格，跳过自动判断',
      scriptKey,
    };
  }

  if (mode === 'auto' && selectedId && String(styleOptions.autoStyleTemplateScriptKey || '') === scriptKey) {
    const styleTemplate = getStyleTemplateForUser(userId, selectedId);
    if (styleTemplate) {
      const cachedSource = cleanString(styleOptions.styleTemplateSelectionSource || 'script_auto_cached', 80);
      return {
        source: (cachedSource === 'script_auto' ? 'script_auto_cached' : cachedSource || 'script_auto_cached') as any,
        decisionSource: 'cached_auto' as const,
        styleTemplate,
        reason: cleanString(styleOptions.autoStyleTemplateReason || '已记录该剧本的自动风格判断结果', 300),
        scriptKey,
      };
    }
  }

  const worldPreferred = resolvePreferredWorldStyleTemplate(userId, worldTemplateSnapshot, scriptKey);
  if (worldPreferred) return worldPreferred;

  const generatedStyleTemplateId = cleanString(
    project.styleBibleGenerationContext?.styleTemplateId
      || project.styleTemplateSnapshot?.id
      || project.styleTemplateSnapshot?.templateId
      || project.styleTemplateSnapshot?.template_id
      || '',
    100,
  );
  if (selectedId && generatedStyleTemplateId && hasGeneratedStyleBibleForRecommendation(project)) {
    const styleTemplate = getStyleTemplateForUser(userId, selectedId);
    if (styleTemplate) {
      return {
        source: 'generated_cached' as const,
        decisionSource: 'cached_generated' as const,
        styleTemplate,
        reason: '该剧本已生成风格圣经，跳过自动风格判断',
        scriptKey,
      };
    }
  }

  if (!mode && selectedId && selectedId !== 'style_live_action_realistic') {
    const styleTemplate = getStyleTemplateForUser(userId, selectedId);
    if (styleTemplate) {
      return {
        source: 'manual_legacy' as const,
        decisionSource: 'cached_manual_legacy' as const,
        styleTemplate,
        reason: '项目已有风格选择，跳过自动判断',
        scriptKey,
      };
    }
  }

  return null;
}

function hasGeneratedStyleBibleForRecommendation(project: any) {
  if (!project || typeof project !== 'object') return false;
  if (project.styleBibleGeneratedAt) return true;
  if (project.styleBibleGenerationContext?.styleTemplateId) return true;
  const styleBible = project.styleBible;
  return !!(styleBible && typeof styleBible === 'object' && Object.keys(styleBible).length > 0);
}

function addTermScore(card: StyleScoreCard, text: string, terms: WeightedTerm[]) {
  for (const term of terms) {
    const raw = Array.isArray(term) ? term[0] : term;
    const weight = Array.isArray(term) ? term[1] : 1;
    const needle = raw.toLowerCase();
    if (!needle || !text.includes(needle)) continue;
    card.score += weight;
    card.hits.push(raw);
  }
}

function matchingTerms(text: string, terms: string[]) {
  return terms.filter((term) => term && text.includes(term));
}

function addAncientContextScores(cards: Record<FeaturedStyleTemplateId, StyleScoreCard>, text: string) {
  const ancientTerms = ['古代', '古装', '朝堂', '皇帝', '王爷', '王妃', '太子', '公主', '将军', '宫廷', '权谋', '江湖', '武侠', '门派', '客栈'];
  const fantasyTerms = ['修仙', '玄幻', '仙侠', '仙尊', '魔尊', '灵力', '灵气', '法术', '妖魔', '神兽', '宗门', '飞升', '渡劫', '上古', '神话'];
  const ancientHits = matchingTerms(text, ancientTerms);
  const fantasyHits = matchingTerms(text, fantasyTerms);
  if (ancientHits.length) {
    cards.style_live_action_costume.score += 3;
    cards.style_live_action_costume.hits.push(...ancientHits.slice(0, 3));
  }
  if (fantasyHits.length) {
    cards.style_3d_xuanhuan.score += 5;
    cards.style_3d_xuanhuan.hits.push(...fantasyHits.slice(0, 3));
  }
  if (ancientHits.length && fantasyHits.length) {
    cards.style_3d_xuanhuan.score += 2;
    cards.style_live_action_costume.score -= 1;
  }
}

function addModernRealityScores(cards: Record<FeaturedStyleTemplateId, StyleScoreCard>, text: string) {
  const modernTerms = ['现代', '当代', '都市', '城市', '职场', '办公室', '家庭', '客厅', '婚礼', '婚内出轨', '出轨', '医院', '学校', '餐厅', '广告牌', '店', '警局', '真实', '现实', '生活'];
  const groundedConflictTerms = ['复仇', '悬疑', '刑侦', '犯罪', '绑架', '追凶', '背叛', '离婚', '商战', '情感', '短剧'];
  const modernHits = matchingTerms(text, modernTerms);
  if (modernHits.length) {
    cards.style_live_action_realistic.score += 3;
    cards.style_live_action_realistic.hits.push(...modernHits.slice(0, 3));
  }
  addTermScore(cards.style_live_action_realistic, text, groundedConflictTerms.map((term) => [term, 1]));
}

export function recommendFeaturedStyleTemplateIdForScript(input: {
  script?: string;
  worldTemplateSnapshot?: any;
}) {
  const world = input.worldTemplateSnapshot || {};
  const text = normalizeRecommendationText(
    input.script,
    world.name,
    world.summary,
    world.description,
    world.worldRules,
    world.setting,
    world.era,
    world.genre,
    Array.isArray(world.tags) ? world.tags.join(' ') : '',
  );
  const cards = FEATURED_STYLE_TEMPLATE_IDS.reduce((acc, id) => {
    acc[id] = { id, score: id === 'style_live_action_realistic' ? 1 : 0, hits: [] };
    return acc;
  }, {} as Record<FeaturedStyleTemplateId, StyleScoreCard>);

  addModernRealityScores(cards, text);
  addAncientContextScores(cards, text);
  addTermScore(cards.style_live_action_realistic, text, [
    ['真人', 2], ['写实', 2], ['现实主义', 3], ['纪实', 1], ['雨夜', 1],
    ['咖啡店', 1], ['火锅', 1], ['便利店', 1], ['街边', 1], ['老板', 1], ['顾客', 1],
  ]);
  addTermScore(cards.style_live_action_costume, text, [
    ['古装', 5], ['宫斗', 4], ['朝堂', 4], ['王朝', 3], ['皇宫', 3], ['王府', 3],
    ['江湖', 3], ['武侠', 3], ['刺客', 2], ['剑客', 2], ['宋代', 2], ['唐代', 2],
    ['明代', 2], ['清代', 2], ['民国', 1],
  ]);
  addTermScore(cards.style_3d_xuanhuan, text, [
    ['玄幻', 6], ['仙侠', 6], ['修仙', 6], ['灵气', 5], ['灵力', 5], ['法术', 5],
    ['神兽', 4], ['妖魔', 3], ['妖兽', 3], ['魔尊', 3], ['魔族', 3], ['魔法', 3],
    ['宗门', 4], ['飞升', 4], ['渡劫', 4], ['仙界', 4], ['神话', 3], ['上古', 3], ['异兽', 3],
    ['混沌', 5], ['圣地', 5], ['长老', 4], ['顿悟', 5], ['妖孽', 4], ['虚空', 4],
    ['山门', 3], ['石碑', 2], ['天骄', 4], ['天赋', 3], ['灵根', 4], ['神体', 4],
    ['道体', 4], ['至尊', 4], ['大帝', 4], ['神通', 4], ['法宝', 3], ['秘境', 3],
    ['洞府', 3], ['仙门', 4], ['仙宗', 4], ['修为', 4], ['境界', 3], ['丹田', 3],
    ['识海', 3], ['异象', 3], ['诸天', 3], ['万族', 3], ['大道', 3],
  ]);
  addTermScore(cards.style_3d_realistic, text, [
    ['3d', 5], ['cg', 5], ['科幻', 5], ['未来', 4], ['太空', 4], ['星舰', 4],
    ['机器人', 4], ['机甲', 4], ['人工智能', 3], ['废土', 3], ['末世', 3],
    ['怪兽', 3], ['异形', 3], ['赛博', 2], ['虚拟现实', 3],
  ]);
  addTermScore(cards.style_2d_animation, text, [
    ['2d', 3], ['动画', 3], ['可爱', 4], ['萌', 3], ['搞笑', 3], ['轻喜剧', 3],
    ['儿童', 4], ['亲子', 3], ['校园日常', 3], ['表情包', 2], ['活泼', 2],
  ]);
  addTermScore(cards.style_2d_movie, text, [
    ['动画电影', 6], ['治愈', 4], ['诗意', 4], ['童话', 4], ['青春', 2],
    ['回忆', 2], ['夏天', 2], ['海边', 2], ['梦境', 3], ['温柔', 2], ['浪漫', 2],
  ]);
  addTermScore(cards.style_hollywood_blockbuster, text, [
    ['好莱坞', 6], ['大片', 5], ['爆炸', 5], ['枪战', 5], ['追车', 5],
    ['战争', 4], ['特工', 4], ['军队', 3], ['空袭', 3], ['灾难', 4],
    ['动作', 3], ['逃亡', 2], ['拯救世界', 4], ['航母', 3],
  ]);

  if (cards.style_hollywood_blockbuster.score >= 6 && cards.style_live_action_realistic.score > cards.style_hollywood_blockbuster.score) {
    cards.style_hollywood_blockbuster.score += 2;
  }
  if (cards.style_2d_movie.score >= 5) cards.style_2d_animation.score -= 1;
  if (cards.style_3d_xuanhuan.score >= 6) cards.style_live_action_costume.score -= 1;

  const scores = Object.values(cards).sort((a, b) => (
    b.score - a.score || FEATURED_STYLE_TEMPLATE_IDS.indexOf(a.id) - FEATURED_STYLE_TEMPLATE_IDS.indexOf(b.id)
  ));
  const winner = scores[0] || cards.style_live_action_realistic;
  const id = winner.score > 1 ? winner.id : 'style_live_action_realistic';
  const reason = winner.score > 1 && winner.hits.length
    ? `匹配到剧本关键词：${Array.from(new Set(winner.hits)).slice(0, 5).join('、')}`
    : '剧本风格信号不足，采用真人写实作为稳妥默认风格';

  return {
    id,
    reason,
    scores: scores.map((card) => ({
      id: card.id,
      score: card.id === id ? Math.max(card.score, 1) : card.score,
      hits: Array.from(new Set(card.hits)).slice(0, 8),
    })),
  };
}

export function recommendStyleTemplateForScriptByRules(userId: number, input: {
  script?: string;
  worldTemplateSnapshot?: any;
}) {
  const recommendation = recommendFeaturedStyleTemplateIdForScript(input);
  const featured = listFeaturedStyleTemplates(userId);
  const styleTemplate = featured.find((tpl: any) => String(tpl.id || '') === recommendation.id)
    || getStyleTemplateForUser(userId, 'style_live_action_realistic')
    || featured[0]
    || null;
  return {
    source: 'script_auto' as const,
    decisionSource: 'rules' as const,
    styleTemplate,
    reason: recommendation.reason,
    scores: recommendation.scores,
  };
}

export async function recommendStyleTemplateForScript(user: UserRow | number, input: {
  script?: string;
  worldTemplateSnapshot?: any;
  projectId?: string | null;
  projectTitleSnapshot?: string | null;
  requestPath?: string | null;
  routeName?: string | null;
}) {
  const userId = styleRecommendationUserId(user);
  const ruleResult = recommendStyleTemplateForScriptByRules(userId, input);
  const userRow = typeof user === 'number' ? null : user;

  try {
    const llmDecision = await recommendFeaturedStyleTemplateIdWithLLM(userRow, input);
    if (!llmDecision) return { ...ruleResult, decisionSource: 'rules_no_model' as const };

    const featured = listFeaturedStyleTemplates(userId);
    const styleTemplate = featured.find((tpl: any) => String(tpl.id || '') === llmDecision.id)
      || ruleResult.styleTemplate
      || getStyleTemplateForUser(userId, 'style_live_action_realistic')
      || featured[0]
      || null;

    if (!styleTemplate) return { ...ruleResult, decisionSource: 'rules_missing_template' as const };

    return {
      source: 'script_auto' as const,
      decisionSource: 'llm' as const,
      styleTemplate,
      reason: llmDecision.reason || '大模型根据剧本语义判断默认风格',
      confidence: llmDecision.confidence,
      evidence: llmDecision.evidence,
      scores: ruleResult.scores,
    };
  } catch (error: any) {
    console.warn('[style-template-recommend] LLM classifier fallback to rules:', error?.message || String(error));
    return {
      ...ruleResult,
      decisionSource: 'rules_fallback' as const,
      llmError: String(error?.message || error || '').slice(0, 300),
    };
  }
}

function styleRecommendationUserId(user: UserRow | number) {
  if (typeof user === 'number') return user;
  return Number.isFinite(Number(user?.id)) ? Number(user.id) : 0;
}

async function recommendFeaturedStyleTemplateIdWithLLM(
  user: UserRow | null,
  input: {
    script?: string;
    worldTemplateSnapshot?: any;
    projectId?: string | null;
    projectTitleSnapshot?: string | null;
    requestPath?: string | null;
    routeName?: string | null;
  },
): Promise<LLMStyleTemplateDecision | null> {
  const script = String(input.script || '').trim();
  if (!script) return null;

  const cfg = resolveTextModelConfig(user, 'projectClassifier');
  if (cfg.mode === 'fake') return null;

  const messages = buildStyleTemplateClassifierMessages(input);
  const tokenContext: TokenUsageContext = {
    projectId: input.projectId || null,
    projectTitleSnapshot: input.projectTitleSnapshot || null,
    requestPath: input.requestPath || null,
    routeName: input.routeName || 'style-template-classifier',
    moduleKey: 'style',
    moduleLabel: '风格页面',
    featureKey: 'style_template_classifier',
    featureLabel: '风格模板推荐',
    callItemType: input.projectId ? 'project' : 'script',
    callItemId: input.projectId || null,
    callItemLabel: input.projectTitleSnapshot || null,
    operationKey: input.projectId ? `style-template-classifier:${input.projectId}` : 'style-template-classifier',
    operationLabel: '风格模板推荐',
  };
  const parsed = await chatCompleteJsonWithRetry(
    user,
    messages,
    {
      temperature: 0,
      maxTokens: 800,
      modelRole: 'projectClassifier',
      reasoningEffort: null,
      maxAttempts: 2,
      traceName: 'style-template-classifier',
      tokenContext,
    },
    (raw) => parseStyleClassifierJson(raw),
    'style-template-classifier',
  );
  return normalizeLLMStyleTemplateDecision(parsed);
}

function parseStyleClassifierJson(raw: string) {
  try {
    return parseJsonLoose(raw);
  } catch (error) {
    const jsonText = extractFirstJsonObject(raw);
    if (!jsonText) throw error;
    return parseJsonLoose(jsonText);
  }
}

function extractFirstJsonObject(raw: string) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

function buildStyleTemplateClassifierMessages(input: {
  script?: string;
  worldTemplateSnapshot?: any;
}): ChatMessage[] {
  const world = input.worldTemplateSnapshot || {};
  const script = String(input.script || '').trim().slice(0, 24_000);
  const worldContext = {
    name: world.name || world.title || '',
    summary: world.summary || world.description || '',
    era: world.era || '',
    genre: world.genre || '',
    setting: world.setting || '',
    tags: Array.isArray(world.tags) ? world.tags.slice(0, 12) : [],
  };

  return [
    {
      role: 'system',
      content:
        '你是短剧/短视频项目的视觉风格分类器。你的任务是根据剧本语义，从 7 个固定风格模板里选择最适合作为默认选项的一个。' +
        '必须做整体语义判断，不要被单个词带偏。只允许返回 JSON 对象，不要 Markdown，不要解释 JSON 之外的文字。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        outputSchema: {
          styleTemplateId: '必须是 options 中的 id',
          confidence: '0 到 1 的数字',
          reason: '一句中文原因，说明核心类型/世界观/视觉生产理由',
          evidence: ['最多 5 个来自剧本的中文证据词或短语'],
        },
        decisionRules: [
          '现代都市、家庭、职场、刑侦、现实情感、真实社会冲突，优先真人写实。',
          '古代/宫廷/江湖/武侠且主要是人类写实叙事，优先真人古装。',
          '修仙、玄幻、仙侠、宗门、圣地、灵力、法术、妖兽、虚空、神体、系统流修炼等强非现实视觉，优先 3D玄幻。古装词和玄幻词同时出现时，除非明确是宫廷写实剧，否则选 3D玄幻。',
          '未来科幻、机甲、机器人、太空、赛博、废土、怪兽/异形且偏真实 CG，优先 3D写实。',
          '可爱、儿童、萌系、轻喜剧、校园日常、表情夸张，优先 2D动画。',
          '治愈、诗意、童话、青春回忆、梦境、动画电影感，优先 2D电影。',
          '枪战、爆炸、追车、战争、灾难、特工、拯救世界等大场面动作，优先 好莱坞大片。',
          '只有在没有明显古装、玄幻、动画、科幻、大片动作信号时，才把真人写实作为稳妥默认。',
        ],
        options: [
          { id: 'style_live_action_realistic', name: '真人写实' },
          { id: 'style_3d_xuanhuan', name: '3D玄幻' },
          { id: 'style_live_action_costume', name: '真人古装' },
          { id: 'style_3d_realistic', name: '3D写实' },
          { id: 'style_2d_animation', name: '2D动画' },
          { id: 'style_2d_movie', name: '2D电影' },
          { id: 'style_hollywood_blockbuster', name: '好莱坞大片' },
        ],
        worldContext,
        script,
      }),
    },
  ];
}

function normalizeLLMStyleTemplateDecision(value: any): LLMStyleTemplateDecision {
  const raw = value && typeof value === 'object' ? value : {};
  const id = normalizeLLMStyleTemplateId(raw.styleTemplateId || raw.style_template_id || raw.id || raw.styleTemplateName || raw.name);
  if (!id) {
    const rawId = String(raw.styleTemplateId || raw.style_template_id || raw.id || raw.styleTemplateName || raw.name || '').trim();
    throw new Error(`风格分类模型返回了非法模板 ID：${rawId || '(empty)'}`);
  }
  const n = Number(raw.confidence);
  const confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.75;
  const reason = cleanString(raw.reason || raw.rationale || '', 300);
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map((item: any) => cleanString(item, 40)).filter(Boolean).slice(0, 5)
    : [];
  return { id, confidence, reason, evidence };
}

function normalizeLLMStyleTemplateId(value: any): FeaturedStyleTemplateId | '' {
  const raw = String(value || '').trim();
  if (FEATURED_STYLE_TEMPLATE_IDS.includes(raw as FeaturedStyleTemplateId)) return raw as FeaturedStyleTemplateId;
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  const byName: Record<string, FeaturedStyleTemplateId> = {
    '真人写实': 'style_live_action_realistic',
    liveactionrealistic: 'style_live_action_realistic',
    realisticliveaction: 'style_live_action_realistic',
    '3d玄幻': 'style_3d_xuanhuan',
    '3d东方玄幻': 'style_3d_xuanhuan',
    '真人古装': 'style_live_action_costume',
    liveactioncostume: 'style_live_action_costume',
    '3d写实': 'style_3d_realistic',
    '3d真实': 'style_3d_realistic',
    '2d动画': 'style_2d_animation',
    '二维动画': 'style_2d_animation',
    '2d电影': 'style_2d_movie',
    '2d动画电影': 'style_2d_movie',
    '好莱坞大片': 'style_hollywood_blockbuster',
    hollywoodblockbuster: 'style_hollywood_blockbuster',
  };
  return byName[compact] || '';
}
