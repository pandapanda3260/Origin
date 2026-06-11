/**
 * 剪辑器画布比例跟随项目 契约测试
 *
 * 背景（2026-06-11）：
 *   VevDemo 工程画布原先写死 1080x1920（9:16），16:9 项目的视频在预览区上下黑边。
 *   现改为三处跟随项目比例（与 edit.js _resolveCurrentExportFormat / 一键成片同口径）：
 *   1. lib/vevdemo-project-registration.ts 创建工程时按 project.data_json 算 Canvas；
 *   2. online_editor.js plan.canvas 带上口径结果；
 *   3. fe/index.js 铺轨时画布不一致则同步（字幕 lane 布局按新画布算）。
 *
 *   口径为双实现（lib ts + oe js），本测试锁两边关键值一致防漂移；
 *   fe/index.js 是未跟踪手改文件，vendor 重同步冲掉即红。
 *
 * 运行：node scripts/test-vev-canvas-follow.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];

function assert(cond, label) {
  if (cond) return;
  failures.push(label);
}

const libTs = readFileSync(join(ROOT, 'lib/vevdemo-project-registration.ts'), 'utf8');
const oeJs = readFileSync(join(ROOT, 'public/modules/online_editor.js'), 'utf8');
const shellJs = readFileSync(join(ROOT, 'vevdemo-1.0.6/fe/index.js'), 'utf8');

function extract(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`无法提取 ${name}`);
  return match[0];
}

// ── 1. 哨兵：三处接线在场 ───────────────────────────────────────
assert(libTs.includes('export function resolveCanvasSizeForProjectData'), 'lib 应有 resolveCanvasSizeForProjectData');
assert(libTs.includes('SELECT id, owner_id, title, data_json FROM projects'), '建绑定查询必须带 data_json（算比例的数据源）');
assert(libTs.includes('buildInitialEditParam(projectName, space, resolveCanvasSizeForProjectData(project.data_json))'), 'CreateProject 必须按项目比例传 Canvas');
assert(/Width: canvas\?\.width \|\| 1080/.test(libTs), 'buildInitialEditParam Canvas 应接收参数（默认 1080x1920 兜底）');
assert(oeJs.includes('canvas: _resolveVevCanvasForProject(project)'), 'plan 必须挂 canvas（铺轨同步画布的数据源）');
assert(shellJs.includes('function resolveTargetCanvasFromPlan'), 'fe/index.js 应有 resolveTargetCanvasFromPlan（vendor 冲掉即红）');
assert(/const track = buildTrackFromOriginPlan\(plan, effectMap, timeUnit, editParamForLayout\)/.test(shellJs), '建轨必须用 editParamForLayout（字幕布局按新画布算）');
assert(/const nextEditParam = \{ \.\.\.editParamForLayout \}/.test(shellJs), 'nextEditParam 必须基于 editParamForLayout（画布写入 updateProject）');
assert(shellJs.includes('canvasFollowed'), '铺轨结果应上报 canvasFollowed');

// ── 2. 双实现口径一致（lib ts 与 oe js 的关键值） ────────────────
for (const source of [libTs, oeJs]) {
  assert(source.includes("'16:9' || ratio === '4:3' || ratio === '21:9'"), '横屏族判定应一致(16:9/4:3/21:9)');
  assert(source.includes('1920') && source.includes('1080'), '横屏尺寸应为 1920x1080');
  assert(source.includes('1024'), '1:1 尺寸应为 1024');
}

// ── 3. 行为：oe 口径函数 ────────────────────────────────────────
const oeSandbox = new Function(`
  ${extract(oeJs, '_resolveVevCanvasForProject')}
  return { _resolveVevCanvasForProject };
`)();

const r1 = oeSandbox._resolveVevCanvasForProject({ styleOptions: { aspectRatio: '16:9' } });
assert(r1.width === 1920 && r1.height === 1080, `16:9 应 1920x1080，实际 ${JSON.stringify(r1)}`);
const r2 = oeSandbox._resolveVevCanvasForProject({});
assert(r2.width === 1080 && r2.height === 1920, `无配置应默认 9:16 竖屏，实际 ${JSON.stringify(r2)}`);
const r3 = oeSandbox._resolveVevCanvasForProject({ styleOptions: { aspectRatio: '怪值' }, styleBible: { aspectRatio: '1:1' } });
assert(r3.width === 1024 && r3.height === 1024, `styleOptions 非法应回退 styleBible，实际 ${JSON.stringify(r3)}`);
const r4 = oeSandbox._resolveVevCanvasForProject({ styleOptions: { aspectRatio: '9:16' }, styleBible: { aspectRatio: '16:9' } });
assert(r4.width === 1080, 'styleOptions 优先级应高于 styleBible');
const r5 = oeSandbox._resolveVevCanvasForProject({ styleOptions: { aspectRatio: '21:9' } });
assert(r5.width === 1920 && r5.height === 1080, '21:9 应归入横屏 1920x1080');

// ── 4. 行为：fe 画布同步判定 ────────────────────────────────────
const feSandbox = new Function(`
  ${extract(shellJs, 'resolveCanvasSize')}
  ${extract(shellJs, 'resolveTargetCanvasFromPlan')}
  return { resolveTargetCanvasFromPlan };
`)();

assert(feSandbox.resolveTargetCanvasFromPlan({}, { Canvas: { Width: 1080, Height: 1920 } }).changed === false, '无 plan.canvas 不应改画布');
assert(feSandbox.resolveTargetCanvasFromPlan({ canvas: { width: 1080, height: 1920 } }, { Canvas: { Width: 1080, Height: 1920 } }).changed === false, '同尺寸不应标记 changed');
const diff = feSandbox.resolveTargetCanvasFromPlan({ canvas: { width: 1920, height: 1080 } }, { Canvas: { Width: 1080, Height: 1920 } });
assert(diff.changed === true && diff.width === 1920 && diff.height === 1080, `不同尺寸应 changed 并带新宽高，实际 ${JSON.stringify(diff)}`);
assert(feSandbox.resolveTargetCanvasFromPlan({ canvas: { width: 0, height: -1 } }, null).changed === false, '非法 plan.canvas 不应改画布');

if (failures.length) {
  console.error(`✗ ${failures.length} 处断言失败：`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('✓ 画布比例跟随项目契约测试通过（哨兵+双实现锁+行为 共 24 断言）');
