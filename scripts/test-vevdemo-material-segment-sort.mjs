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
assert(
  normalizeBlock && normalizeBlock[0].includes('params.Offset') && normalizeBlock[0].includes('params.offset'),
  '从系统导入分页必须兼容火山 SDK 传入的 Offset/offset',
);
assert(
  normalizeBlock && normalizeBlock[0].includes('params.Limit') && normalizeBlock[0].includes('params.limit'),
  '从系统导入分页必须兼容火山 SDK 传入的 Limit/limit',
);
assert(
  shellJs.includes('const vid = originId ? originVideoSyntheticVid(originId) : realVid;'),
  '"从系统导入"搜索结果必须始终使用 origin-video-task:<id> 合成 Vid，避免 SDK 直接按真实 Vid 重复创建素材',
);
assert(
  shellJs.includes('function createOrReuseOriginEditMaterial'),
  'fe/index.js 应包一层 createOrReuseOriginEditMaterial，按 Source 复用已有 edit material',
);
assert(
  /createEditMaterial:\s*createOrReuseOriginEditMaterial/.test(shellJs),
  'VevDemo actions.createEditMaterial 必须接到 Source 去重包装函数',
);
assert(
  shellJs.includes('function dedupeEditMaterialResultBySource'),
  '素材库 SearchEditMaterial 结果必须能按 Source 去重，隐藏 SDK 已创建的重复素材',
);
assert(
  shellJs.includes('dedupeEditMaterialResultBySource(scopedResult.result)'),
  'searchOriginScopedEditMaterial 返回前必须执行 Source 去重',
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

// 2f. 火山 SDK 的分页控件传 Offset + Limit，不传 PageNum；必须能切到第二页
const pagingSandbox = new Function(`
  const activeOriginProjectId = 'pid-test';
  const readSearchKeyword = () => '';
  const matchesOriginVideoSearch = () => true;
  const normalizeOriginVideoForSearch = (item) => item;
  ${reMatch[0]}
  ${extract('readMaterialDisplayNameForOrder')}
  ${extract('segmentOrderKeyForMaterial')}
  ${extract('sortMaterialListBySegmentOrder')}
  ${extract('readPositivePagingNumber')}
  ${extract('readNonNegativePagingOffset')}
  ${extract('normalizeOriginProjectVideoSearchResult')}
  return { normalizeOriginProjectVideoSearchResult };
`)();

const videos = Array.from({ length: 13 }, (_, i) => mk(`片段${13 - i}`));
const firstOffsetPage = pagingSandbox.normalizeOriginProjectVideoSearchResult({ videos }, { Offset: 0, Limit: 2 });
assert(
  JSON.stringify(names(firstOffsetPage.VideoSet.VideoInfos)) === JSON.stringify([mk('片段1').Name, mk('片段2').Name]),
  `Offset=0, Limit=2 应返回第一页，实际：${names(firstOffsetPage.VideoSet.VideoInfos).join(' | ')}`,
);
const secondOffsetPage = pagingSandbox.normalizeOriginProjectVideoSearchResult({ videos }, { Offset: 12, Limit: 12 });
assert(
  JSON.stringify(names(secondOffsetPage.VideoSet.VideoInfos)) === JSON.stringify([mk('片段13').Name]),
  `Offset=12, Limit=12 应返回第二页剩余素材，实际：${names(secondOffsetPage.VideoSet.VideoInfos).join(' | ')}`,
);
const pageNumFallback = pagingSandbox.normalizeOriginProjectVideoSearchResult({ videos }, { PageNum: 2, PageSize: 2 });
assert(
  JSON.stringify(names(pageNumFallback.VideoSet.VideoInfos)) === JSON.stringify([mk('片段3').Name, mk('片段4').Name]),
  `PageNum/PageSize 兼容路径应继续可用，实际：${names(pageNumFallback.VideoSet.VideoInfos).join(' | ')}`,
);

// 2g. SDK 重复 CreateEditMaterial 后，同 Source 只展示一次；无 Source 的本地素材不被误删
const dedupeSandbox = new Function(`
  ${extract('readFirst')}
  ${extract('readEditMaterialSource')}
  ${extract('dedupeMaterialListBySource')}
  return { dedupeMaterialListBySource };
`)();
const deduped = dedupeSandbox.dedupeMaterialListBySource([
  { Name: '片段1.mp4', Source: 'vid://same' },
  { Name: '片段1 duplicate.mp4', Source: 'vid://same' },
  { Name: '片段2.mp4', BasicInfo: { Source: 'vid://second' } },
  { Name: '本地素材无 Source.mp4' },
]);
assert(deduped.changed === true, '重复 Source 应报告 changed=true');
assert(
  JSON.stringify(names(deduped.list)) === JSON.stringify(['片段1.mp4', '片段2.mp4', '本地素材无 Source.mp4']),
  `同 Source 应只保留首个素材，实际：${names(deduped.list).join(' | ')}`,
);

if (failures.length) {
  console.error(`✗ ${failures.length} 处断言失败：`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('✓ vevdemo 素材片段排序/分页/导入去重契约测试通过');
