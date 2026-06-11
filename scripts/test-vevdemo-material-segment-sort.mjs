/**
 * 剪辑器素材库"片段编号自然排序" 契约测试
 *
 * 背景（2026-06-10）：
 *   素材库面板（searchEditMaterial 列表源）与"从系统导入"弹窗（searchVideo）
 *   默认按导入时间/字符串序展示，片段10 会排到 片段2 前面。
 *   现统一按片段编号自然排序：片段1 → 片段1（1）→ 片段1（2）→ 片段2 → … → 片段10；
 *   非"片段N"命名（本地上传等）排在所有片段之后，保持原相对顺序。
 *
 *   vevdemo-1.0.6/fe/index.js 是未跟踪手改文件，vendor 重同步会把排序静默冲掉——
 *   本测试兼当哨兵，冲掉即红。
 *
 * 运行：node scripts/test-vevdemo-material-segment-sort.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function assert(cond, label) {
  if (cond) return;
  failures.push(label);
}

const shellJs = readFileSync(join(ROOT, 'vevdemo-1.0.6/fe/index.js'), 'utf8');

// ── 1. 哨兵：排序代码与两处接线必须在场 ─────────────────────────
assert(shellJs.includes('SEGMENT_NAME_ORDER_RE'), 'fe/index.js 应定义 SEGMENT_NAME_ORDER_RE（vendor 重同步冲掉即红）');
assert(shellJs.includes('function sortMaterialListBySegmentOrder'), 'fe/index.js 应存在 sortMaterialListBySegmentOrder');
assert(
  /return sortEditMaterialResultBySegmentOrder\(applyOriginTitlesToEditMaterialResult\(/.test(shellJs),
  'searchOriginScopedEditMaterial 必须在标题应用后包一层片段排序（素材库面板顺序）',
);
const normalizeBlock = shellJs.match(/function normalizeOriginProjectVideoSearchResult\(payload, params = \{\}\) \{[\s\S]*?\n\}/);
assert(normalizeBlock, 'fe/index.js 应存在 normalizeOriginProjectVideoSearchResult');
assert(
  normalizeBlock && normalizeBlock[0].includes('sortMaterialListBySegmentOrder('),
  '"从系统导入"列表必须在分页切片前排序（翻页边界才按片段编号连续）',
);
assert(
  normalizeBlock && normalizeBlock[0].indexOf('sortMaterialListBySegmentOrder(') < normalizeBlock[0].indexOf('.slice(start'),
  '排序必须发生在 .slice 分页之前',
);

// ── 2. 行为：提取真实实现跑断言 ─────────────────────────────────
function extract(name) {
  const match = shellJs.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`无法从 fe/index.js 提取 ${name}`);
  return match[0];
}
const reMatch = shellJs.match(/const SEGMENT_NAME_ORDER_RE = .*;/);
if (!reMatch) throw new Error('无法提取 SEGMENT_NAME_ORDER_RE');

const sandbox = new Function(`
  const EDIT_MATERIAL_LIST_KEYS = ['Detail', 'EditMaterialList', 'MaterialList'];
  ${reMatch[0]}
  ${extract('readMaterialDisplayNameForOrder')}
  ${extract('segmentOrderKeyForMaterial')}
  ${extract('sortMaterialListBySegmentOrder')}
  ${extract('sortEditMaterialResultBySegmentOrder')}
  return { sortMaterialListBySegmentOrder, sortEditMaterialResultBySegmentOrder, segmentOrderKeyForMaterial };
`)();

const names = (list) => list.map((x) => x.Name);
const mk = (name) => ({ Name: `${name}第一章 混沌聖地收徒.mp4` });

// 2a. 数字序而非字符串序；同片段多视频按（M）子序；全角/半角括号都认
const sorted = sandbox.sortMaterialListBySegmentOrder([
  mk('片段10'), mk('片段2'), mk('片段1（2）'), mk('片段1'), mk('片段1(1)'),
]);
assert(
  JSON.stringify(names(sorted)) === JSON.stringify([
    mk('片段1').Name, mk('片段1(1)').Name, mk('片段1（2）').Name, mk('片段2').Name, mk('片段10').Name,
  ]),
  `片段排序应为 1 → 1(1) → 1（2） → 2 → 10，实际：${names(sorted).join(' | ')}`,
);

// 2b. 非片段命名排在末尾且保持相对顺序；原数组不被原地修改
const input = [{ Name: 'B本地上传.mp4' }, mk('片段3'), { Name: 'A录屏.mov' }, mk('片段1')];
const inputSnapshot = JSON.stringify(input);
const mixed = sandbox.sortMaterialListBySegmentOrder(input);
assert(
  JSON.stringify(names(mixed)) === JSON.stringify([mk('片段1').Name, mk('片段3').Name, 'B本地上传.mp4', 'A录屏.mov']),
  `非片段命名应稳定排在片段之后，实际：${names(mixed).join(' | ')}`,
);
assert(JSON.stringify(input) === inputSnapshot, 'sortMaterialListBySegmentOrder 不应原地修改入参数组');

// 2c. 标题字段兜底：Title/BasicInfo.Name 也能作为排序键
const byTitle = sandbox.sortMaterialListBySegmentOrder([
  { Title: '片段2_x.mp4' }, { BasicInfo: { Name: '片段1_x.mp4' } },
]);
assert(
  byTitle[0].BasicInfo && byTitle[1].Title === '片段2_x.mp4',
  '排序键应兜底读 Title / BasicInfo.Name',
);

// 2d. result 三个列表键都排序，其他字段原样保留
const result = sandbox.sortEditMaterialResultBySegmentOrder({
  Total: 2,
  Detail: [mk('片段2'), mk('片段1')],
  EditMaterialList: [mk('片段10'), mk('片段9')],
  Extra: 'keep',
});
assert(
  result.Detail[0].Name === mk('片段1').Name && result.EditMaterialList[0].Name === mk('片段9').Name && result.Extra === 'keep' && result.Total === 2,
  'sortEditMaterialResultBySegmentOrder 应排序所有列表键并保留其余字段',
);

// 2e. 边界：空/非数组/无名条目不抛错
assert(sandbox.sortMaterialListBySegmentOrder(null) === null, '非数组入参应原样返回');
assert(Array.isArray(sandbox.sortMaterialListBySegmentOrder([])), '空数组应原样返回');
assert(sandbox.segmentOrderKeyForMaterial({}) === null, '无名条目排序键应为 null');

if (failures.length) {
  console.error(`✗ ${failures.length} 处断言失败：`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('✓ vevdemo 素材片段排序契约测试通过（哨兵 + 行为 共 13 断言）');
