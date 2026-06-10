import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api-helpers';
import { getDb } from '@/lib/db';
import { getProjectByIdForUser } from '@/lib/projects-db';
import { chatCompleteJsonWithRetry, parseJsonLoose } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ContinuityWarning = {
  key: string;
  pairKey: string;
  fromGroupIdx: number;
  toGroupIdx: number;
  category: 'scene' | 'character' | 'prop' | 'camera' | 'other';
  severity: 'low' | 'medium' | 'high';
  title: string;
  reason: string;
  suggestion: string;
  evidence?: string;
  canIgnore: boolean;
};

const SP_CONTINUITY = `你是影视分镜连续性检查官。你只检查相邻视频片段是否存在明显穿帮或难以衔接的问题。

检查维度：
1. 场景连续性：室内/室外、地点、昼夜、天气、光线是否无理由跳变。
2. 角色连续性：同一角色的服装、位置、动作状态、手持物是否突然变化。
3. 道具连续性：关键道具是否无理由突然出现或消失。
4. 镜头连续性：景别、视线方向、运镜方向是否明显接不上。

重要规则：
- 如果输入里标记 boundaryHint=true，或文本明确包含"转场/第二天/几小时后/切到/与此同时/回忆/梦境/字幕提示"等时间或场景边界，不要把地点、昼夜、光线变化当成错误。
- 只报会影响观众理解或视频生成质量的问题；不要挑细枝末节。
- 不要改写剧本，不要输出长篇解释，只输出严格 JSON。

输出格式：
{
  "pairs": [
    {
      "pairKey": "0-1",
      "warnings": [
        {
          "category": "scene|character|prop|camera|other",
          "severity": "low|medium|high",
          "title": "一句话问题",
          "reason": "为什么接不上",
          "suggestion": "生成前该怎么处理",
          "evidence": "依据的简短原文"
        }
      ]
    }
  ]
}`;

function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value: any): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function cleanStr(...vals: any[]) {
  for (const v of vals) {
    const s = (v == null ? '' : String(v)).trim();
    if (s) return s.slice(0, 600);
  }
  return '';
}

function toNames(input: any) {
  if (!input) return [] as string[];
  if (Array.isArray(input)) return input.map(x => typeof x === 'string' ? x : cleanStr(x?.name, x?.id)).filter(Boolean).slice(0, 8);
  return String(input).split(/[、,，/]/).map(s => s.trim()).filter(Boolean).slice(0, 8);
}

function hasBoundaryHint(text: string) {
  return /转场|切到|切至|第二天|次日|翌日|几小时后|数小时后|与此同时|另一边|回忆|梦境|字幕|黑场|fade|cut to|meanwhile|later|next day/i.test(text || '');
}

function slimAssets(project: any) {
  const chars = Array.isArray(project?.assets?.characters) ? project.assets.characters
    : Array.isArray(project?.characters) ? project.characters : [];
  const scenes = Array.isArray(project?.assets?.scenes) ? project.assets.scenes
    : Array.isArray(project?.environments) ? project.environments : [];
  const props = Array.isArray(project?.assets?.props) ? project.assets.props
    : Array.isArray(project?.props) ? project.props : [];
  return {
    characters: chars.slice(0, 20).map((c: any) => ({
      id: cleanStr(c.id, c.name),
      name: cleanStr(c.name, c.id),
      clothing: cleanStr(c.clothing, c.equipment, c.description),
      traits: cleanStr(c.appearance, c.identity, c.role),
    })),
    scenes: scenes.slice(0, 20).map((s: any) => ({
      id: cleanStr(s.id, s.name),
      name: cleanStr(s.name, s.id),
      location: cleanStr(s.location, s.description),
      time: cleanStr(s.timeSetting, s.time, s.weather, s.lighting),
      tags: Array.isArray(s.tags) ? s.tags.slice(0, 8) : [],
    })),
    props: props.slice(0, 30).map((p: any) => ({
      id: cleanStr(p.id, p.name),
      name: cleanStr(p.name, p.id),
      type: cleanStr(p.propType, p.type),
      owner: cleanStr(p.ownership, p.owner),
      description: cleanStr(p.description, p.visual),
    })),
  };
}

function buildGroups(project: any) {
  const storyboards = Array.isArray(project?.storyboards) ? project.storyboards : [];
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  return storyboards.map((sb: any, idx: number) => {
    const shotIndices = Array.isArray(sb?.shotIndices) && sb.shotIndices.length ? sb.shotIndices : [idx];
    const relatedShots = shotIndices.map((i: any) => shots[Number(i)]).filter(Boolean);
    const allText = [
      sb?.videoPrompt,
      sb?.imagePrompt,
      sb?.visual,
      sb?.description,
      ...relatedShots.flatMap((sh: any) => [sh.visual, sh.dialogue, sh.scriptRef, sh.keyInfo, sh.camera, sh.shotType]),
    ].map(x => cleanStr(x)).filter(Boolean).join('\n');
    return {
      groupIdx: idx,
      shotIndices,
      boundaryHint: !!sb?.boundaryHint || hasBoundaryHint(allText),
      scene: cleanStr(sb?.sceneName, sb?.scene, relatedShots[0]?.scene, relatedShots[0]?.location),
      time: cleanStr(sb?.timeSetting, sb?.time, sb?.lighting, relatedShots[0]?.time, relatedShots[0]?.lighting),
      camera: relatedShots.map((sh: any) => cleanStr(sh.camera, sh.shotType, sh.movement)).filter(Boolean).join(' / ').slice(0, 300),
      characters: Array.from(new Set([
        ...toNames(sb?.characters),
        ...relatedShots.flatMap((sh: any) => toNames(sh.characters)),
      ])).slice(0, 8),
      props: Array.from(new Set([
        ...toNames(sb?.props),
        ...relatedShots.flatMap((sh: any) => toNames(sh.props || sh.keyInfo)),
      ])).slice(0, 8),
      visual: cleanStr(sb?.visual, sb?.imagePrompt, relatedShots.map((sh: any) => sh.visual).filter(Boolean).join('\n')),
      dialogue: cleanStr(relatedShots.map((sh: any) => cleanStr(sh.dialogue, sh.scriptRef)).filter(Boolean).join('\n')),
      videoPrompt: cleanStr(sb?.videoPrompt),
    };
  }).filter((g: any) => g.videoPrompt || g.visual || g.dialogue);
}

function selectPairs(groups: any[], selected: number[]) {
  const selectedSet = new Set(selected);
  const pairs: any[] = [];
  for (let i = 0; i < groups.length - 1; i += 1) {
    const a = groups[i];
    const b = groups[i + 1];
    if (!a || !b) continue;
    if (selectedSet.size && !selectedSet.has(a.groupIdx) && !selectedSet.has(b.groupIdx)) continue;
    pairs.push({
      pairKey: `${a.groupIdx}-${b.groupIdx}`,
      fromGroupIdx: a.groupIdx,
      toGroupIdx: b.groupIdx,
      boundaryHint: !!a.boundaryHint || !!b.boundaryHint,
      from: a,
      to: b,
    });
  }
  return pairs.slice(0, 80);
}

function normalizeSeverity(v: any): 'low' | 'medium' | 'high' {
  const s = String(v || '').toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  if (/高|严重/.test(String(v || ''))) return 'high';
  if (/中/.test(String(v || ''))) return 'medium';
  return 'low';
}

function normalizeCategory(v: any): ContinuityWarning['category'] {
  const s = String(v || '').toLowerCase();
  if (['scene', 'character', 'prop', 'camera', 'other'].includes(s)) return s as any;
  if (/场景|地点|昼夜|天气|光/.test(String(v || ''))) return 'scene';
  if (/角色|服装|手持|位置/.test(String(v || ''))) return 'character';
  if (/道具|物件/.test(String(v || ''))) return 'prop';
  if (/镜头|运镜|景别|视线/.test(String(v || ''))) return 'camera';
  return 'other';
}

function normalizePairResult(pair: any, raw: any) {
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings : [];
  return warnings.slice(0, 6).map((w: any) => {
    const category = normalizeCategory(w.category);
    const severity = normalizeSeverity(w.severity);
    const title = cleanStr(w.title, w.reason, '连续性提醒').slice(0, 80);
    const reason = cleanStr(w.reason, w.evidence, title).slice(0, 240);
    const suggestion = cleanStr(w.suggestion, '确认这是故意变化，或在生成前统一相邻镜头描述').slice(0, 240);
    const evidence = cleanStr(w.evidence).slice(0, 180);
    const key = createHash('sha1')
      .update([pair.pairKey, category, severity, title, reason].join('|'))
      .digest('hex')
      .slice(0, 16);
    return {
      key,
      pairKey: pair.pairKey,
      fromGroupIdx: pair.fromGroupIdx,
      toGroupIdx: pair.toGroupIdx,
      category,
      severity,
      title,
      reason,
      suggestion,
      evidence,
      canIgnore: true,
    } satisfies ContinuityWarning;
  }).filter((w: ContinuityWarning) => w.reason);
}

function ensureContinuityCacheTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS continuity_cache (
      id            TEXT PRIMARY KEY,
      owner_id      INTEGER NOT NULL,
      project_id    TEXT NOT NULL DEFAULT '',
      pair_key      TEXT NOT NULL,
      input_hash    TEXT NOT NULL,
      result_json   TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(owner_id, project_id, pair_key, input_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_continuity_cache_owner_project
      ON continuity_cache(owner_id, project_id, updated_at DESC);
  `);
}

function getCached(ownerId: number, projectId: string, pairKey: string, inputHash: string) {
  ensureContinuityCacheTable();
  const row = getDb()
    .prepare<{ ownerId: number; projectId: string; pairKey: string; inputHash: string }, any>(
      `SELECT result_json FROM continuity_cache
       WHERE owner_id=@ownerId AND project_id=@projectId AND pair_key=@pairKey AND input_hash=@inputHash`,
    )
    .get({ ownerId, projectId, pairKey, inputHash });
  if (!row) return null;
  try { return JSON.parse(row.result_json || '{}'); } catch { return null; }
}

function setCached(ownerId: number, projectId: string, pairKey: string, inputHash: string, result: any) {
  ensureContinuityCacheTable();
  getDb().prepare(
    `INSERT INTO continuity_cache (id, owner_id, project_id, pair_key, input_hash, result_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, project_id, pair_key, input_hash) DO UPDATE SET
       result_json=excluded.result_json,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(randomUUID(), ownerId, projectId, pairKey, inputHash, JSON.stringify(result || {}));
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);
  const body = await req.json().catch(() => ({} as any));

  const projectId = cleanStr(body.projectId, body.project?.id).slice(0, 120);
  const project = body.project || (projectId ? getProjectByIdForUser(projectId, user.id) : null);
  if (!project) return jsonError('项目不存在', 404);

  const groups = Array.isArray(body.groups) && body.groups.length ? body.groups : buildGroups(project);
  const selected = Array.isArray(body.indices) ? body.indices.map((x: any) => Number(x)).filter(Number.isFinite) : [];
  const pairs = selectPairs(groups, selected);
  if (!pairs.length) {
    return jsonOk({ ok: true, projectId, checkedPairs: 0, cachedPairs: 0, modelPairs: 0, warnings: [], pairs: [] });
  }

  const assets = slimAssets(project);
  const ignoredKeys = new Set(Array.isArray(body.ignoredKeys) ? body.ignoredKeys.map((x: any) => String(x)) : []);
  const cachedResults: any[] = [];
  const missing: any[] = [];

  for (const pair of pairs) {
    const input = { pair, assets };
    const inputHash = hashJson(input);
    const cached = body.force ? null : getCached(user.id, projectId, pair.pairKey, inputHash);
    if (cached) cachedResults.push({ pair, inputHash, result: cached, cached: true });
    else missing.push({ pair, inputHash });
  }

  const modelResults: any[] = [];
  if (missing.length) {
    // 并行分片：原先把所有未命中缓存的相邻对塞进一次大模型调用，延迟随对数线性增长
    // （≈1400+650*n maxTokens 的长输出）。现在按固定片大小拆成多路并发小调用，
    // 整体等待≈最慢一片。modelRole/temperature 不变；maxTokens 是任务输出预算，
    // 最终仍由统一预算层 clamp（见 docs/model-config-governance.md）。
    // 失败语义：单片失败只丢该片检查结果（fail-open，与原行为一致）；
    // 全部片失败才返回 checkFailed=true，前端照旧放行生成。
    const CONTINUITY_PAIRS_PER_CALL = 4;
    const CONTINUITY_MAX_CONCURRENT_CALLS = 4;
    const chunks: Array<typeof missing> = [];
    for (let i = 0; i < missing.length; i += CONTINUITY_PAIRS_PER_CALL) {
      chunks.push(missing.slice(i, i + CONTINUITY_PAIRS_PER_CALL));
    }
    let failedChunks = 0;
    let lastError: any = null;
    const runChunk = async (chunk: typeof missing) => {
      const llmInput = {
        assets,
        pairs: chunk.map(x => x.pair),
      };
      const maxTokens = Math.min(12000, Math.max(3500, 1400 + chunk.length * 650));
      try {
        const json = await chatCompleteJsonWithRetry<any>(
          user,
          [
            { role: 'system', content: SP_CONTINUITY },
            { role: 'user', content: JSON.stringify(llmInput) },
          ],
          { temperature: 0.1, maxTokens, modelRole: 'continuity' },
          parseJsonLoose,
          'continuity.check-adjacent',
        );
        const rawPairs = Array.isArray(json?.pairs) ? json.pairs : [];
        for (const item of chunk) {
          const raw = rawPairs.find((p: any) => String(p?.pairKey) === item.pair.pairKey) || { warnings: [] };
          const result = { warnings: normalizePairResult(item.pair, raw) };
          setCached(user.id, projectId, item.pair.pairKey, item.inputHash, result);
          modelResults.push({ pair: item.pair, inputHash: item.inputHash, result, cached: false });
        }
      } catch (e: any) {
        failedChunks += 1;
        lastError = e;
        console.warn('[continuity] chunk check failed:', e?.message || e);
      }
    };
    const queue = chunks.slice();
    const workers = Array.from(
      { length: Math.min(CONTINUITY_MAX_CONCURRENT_CALLS, queue.length) },
      async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await runChunk(next);
      },
    );
    await Promise.all(workers);
    if (failedChunks === chunks.length) {
      return jsonOk({
        ok: true,
        projectId,
        checkedPairs: pairs.length,
        cachedPairs: cachedResults.length,
        modelPairs: 0,
        checkFailed: true,
        error: lastError?.message || String(lastError || 'continuity model check failed'),
        warnings: [],
        pairs: pairs.map(p => ({ pairKey: p.pairKey, fromGroupIdx: p.fromGroupIdx, toGroupIdx: p.toGroupIdx, warningCount: 0 })),
      });
    }
  }

  const results = [...cachedResults, ...modelResults].sort((a, b) => a.pair.fromGroupIdx - b.pair.fromGroupIdx);
  const warnings = results
    .flatMap(r => Array.isArray(r.result?.warnings) ? r.result.warnings : [])
    .filter((w: ContinuityWarning) => !ignoredKeys.has(w.key));

  return jsonOk({
    ok: true,
    projectId,
    checkedPairs: pairs.length,
    cachedPairs: cachedResults.length,
    modelPairs: modelResults.length,
    // 部分分片失败时这里 >0：这些对本次未检查（fail-open 放行），仅作观测用
    uncheckedPairs: Math.max(0, missing.length - modelResults.length),
    warnings,
    pairs: results.map(r => ({
      pairKey: r.pair.pairKey,
      fromGroupIdx: r.pair.fromGroupIdx,
      toGroupIdx: r.pair.toGroupIdx,
      cached: !!r.cached,
      warningCount: (r.result?.warnings || []).length,
    })),
  });
}
