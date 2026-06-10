import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 契约测试：连续性检查并行分片（/api/continuity/check-adjacent）。
 *
 * 跑法:
 *   node scripts/test-continuity-parallel-chunking.mjs
 *
 * 锁定的契约：
 *   A. 未命中缓存的相邻对必须按固定片大小拆分，不允许回退为"整批一次大调用"；
 *   B. 分片通过有限并发池跑（Promise.all + worker 数受上限约束）；
 *   C. maxTokens 预算按"片内对数"计算，不再按全量 missing 计算；
 *   D. 失败语义保持 fail-open：单片失败只记数不抛出；全部片失败才 checkFailed=true；
 *   E. 模型路由治理不变：modelRole 'continuity'，不得出现 modelOverride/reasoningEffort 硬编码；
 *   F. 成功响应暴露 uncheckedPairs 观测字段（部分分片失败时 >0）。
 */

const routeSource = readFileSync(
  new URL('../app/api/continuity/check-adjacent/route.ts', import.meta.url),
  'utf8',
);

// A. 分片切割存在，且按 CONTINUITY_PAIRS_PER_CALL 步进
assert.match(
  routeSource,
  /const CONTINUITY_PAIRS_PER_CALL = \d+/,
  '必须用单点常量定义每片相邻对数',
);
assert.match(
  routeSource,
  /for \(let i = 0; i < missing\.length; i \+= CONTINUITY_PAIRS_PER_CALL\)[\s\S]*?missing\.slice\(i, i \+ CONTINUITY_PAIRS_PER_CALL\)/,
  '必须按片大小切割 missing 列表',
);
assert.doesNotMatch(
  routeSource,
  /pairs:\s*missing\.map\(/,
  '不允许把全量 missing 塞进一次模型调用（回退到旧的单次大调用）',
);

// B. 有限并发池
assert.match(
  routeSource,
  /const CONTINUITY_MAX_CONCURRENT_CALLS = \d+/,
  '必须用单点常量定义最大并发路数',
);
assert.match(
  routeSource,
  /Math\.min\(CONTINUITY_MAX_CONCURRENT_CALLS, queue\.length\)[\s\S]*?await Promise\.all\(workers\)/,
  'worker 数必须受并发上限约束，且整体 await Promise.all',
);

// C. maxTokens 按片内对数计算
assert.match(
  routeSource,
  /maxTokens = Math\.min\(12000, Math\.max\(3500, 1400 \+ chunk\.length \* 650\)\)/,
  'maxTokens 预算必须按 chunk.length 计算',
);
assert.doesNotMatch(
  routeSource,
  /1400 \+ missing\.length \* 650/,
  'maxTokens 不得再按全量 missing.length 计算',
);

// D. fail-open 语义：单片失败只计数；全部失败才 checkFailed
assert.match(
  routeSource,
  /catch \(e: any\) \{\s*failedChunks \+= 1;\s*lastError = e;/,
  '单片失败必须只记数并继续（fail-open），不得中断其他片',
);
assert.match(
  routeSource,
  /if \(failedChunks === chunks\.length\) \{[\s\S]*?checkFailed: true/,
  '只有全部分片失败才返回 checkFailed=true（保持旧契约）',
);

// E. 模型路由治理：role 不变、无硬编码调参
assert.match(
  routeSource,
  /modelRole: 'continuity'/,
  'modelRole 必须保持 continuity',
);
assert.doesNotMatch(
  routeSource,
  /modelOverride|reasoningEffort/,
  '业务路由不得硬编码 modelOverride/reasoningEffort（见 docs/model-config-governance.md）',
);

// F. 观测字段
assert.match(
  routeSource,
  /uncheckedPairs: Math\.max\(0, missing\.length - modelResults\.length\)/,
  '成功响应必须暴露 uncheckedPairs（部分分片失败可观测）',
);

// 缓存写入仍按"对"粒度（分片不得改变缓存粒度）
assert.match(
  routeSource,
  /for \(const item of chunk\) \{[\s\S]*?setCached\(user\.id, projectId, item\.pair\.pairKey, item\.inputHash, result\)/,
  '缓存必须仍按相邻对粒度写入',
);

console.log('test-continuity-parallel-chunking passed (10 断言)');
