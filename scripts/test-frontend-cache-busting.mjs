/**
 * 前端缓存击穿（?v=）契约测试
 *
 * 背景：2026-06-09 提交 5b4a053 把 edit.js / videoTasks.js 的 import 改成无 ?v
 * 的裸路径，loading.js 等新模块出生即无版本号。此后各会话"bump 版本"全部落空，
 * 浏览器长期跑旧 ESM 缓存，制造出"代码已修但浏览器仍是旧行为"的幽灵 bug
 * （实锤案例：2026-06-10 任务列表"继续制作"按已删除的旧 flag 口径跳资产页 + 整页空白）。
 *
 * 契约：
 *   1. public/main.js 与 public/modules/*.js 里所有本地模块 import 必须带 ?v=<数字>；
 *   2. 同一个目标文件在全仓引用（含 workspace.html 的 script/link 标签）版本号必须一致；
 *   3. workspace.html 引用的本地 js/css 必须带 ?v=。
 *
 * 运行：node scripts/test-frontend-cache-busting.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = join(ROOT, 'public');

const failures = [];
const refs = new Map(); // base -> Map(version -> [где])

function record(base, version, where) {
  if (!refs.has(base)) refs.set(base, new Map());
  const m = refs.get(base);
  if (!m.has(version)) m.set(version, []);
  m.get(version).push(where);
}

function lineOf(text, pos) {
  const ls = text.lastIndexOf('\n', pos) + 1;
  const le = text.indexOf('\n', pos);
  return text.slice(ls, le === -1 ? text.length : le).trim();
}

// ── 1/2: JS 模块 import ──────────────────────────────────────────
const jsFiles = [join(PUB, 'main.js'), ...readdirSync(join(PUB, 'modules'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(PUB, 'modules', f))];

const specRe = /(from\s*|^\s*import\s*)(['"])([^'"]+?)\2/gm;
for (const file of jsFiles) {
  const src = readFileSync(file, 'utf8');
  const fname = 'public/' + file.slice(PUB.length + 1).replace(/\\/g, '/');
  for (const m of src.matchAll(specRe)) {
    const spec = m[3];
    const line = lineOf(src, m.index);
    if (line.startsWith('*') || line.startsWith('//')) continue; // 注释示例
    // 只管本地相对/绝对模块路径（裸包名/URL 不管）
    if (!/^[./]/.test(spec)) continue;
    if (!/\.js(\?|$)/.test(spec)) continue;
    const base = basename(spec.replace(/\?v=\d+$/, ''));
    const vm = spec.match(/\?v=(\d+)$/);
    if (!vm) {
      failures.push(`[无版本号] ${fname} → "${spec}"  （行：${line.slice(0, 90)}）`);
      record(base, '(bare)', fname);
    } else {
      record(base, vm[1], fname);
    }
  }
}

// ── 3: workspace.html 的 script/link 引用 + importmap ────────────
// 注意：显式带 ?v= 的 import 说明符会**绕过** importmap（URL 不再命中无查询串的
// map key）。因此 map 条目与各 import 现场的 ?v 必须同号，否则同一模块会按两个
// URL 各加载一份实例（模块级状态分裂，历史踩坑：utils v201/v203 双实例）。
const html = readFileSync(join(PUB, 'workspace.html'), 'utf8');
const imRaw = html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/);
if (imRaw) {
  let im;
  try { im = JSON.parse(imRaw[1]); } catch (e) {
    failures.push(`[importmap 解析失败] ${e.message}`);
  }
  for (const [key, target] of Object.entries(im?.imports || {})) {
    const base = basename(key.replace(/\?v=\d+$/, ''));
    const vm = String(target).match(/\?v=(\d+)$/);
    if (!vm) {
      failures.push(`[无版本号] importmap → "${key}": "${target}"`);
      record(base, '(bare)', 'workspace.html(importmap)');
    } else {
      record(base, vm[1], 'workspace.html(importmap)');
    }
  }
}
for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?v=\d+)?)"/g)) {
  const spec = m[1];
  if (/^https?:\/\//.test(spec)) continue;
  const base = basename(spec.replace(/\?v=\d+$/, ''));
  const vm = spec.match(/\?v=(\d+)$/);
  if (!vm) {
    failures.push(`[无版本号] public/workspace.html → "${spec}"`);
    record(base, '(bare)', 'public/workspace.html');
  } else {
    record(base, vm[1], 'public/workspace.html');
  }
}

// ── 2: 同文件多版本冲突 ──────────────────────────────────────────
for (const [base, vers] of refs) {
  if (vers.size > 1) {
    const detail = [...vers.entries()]
      .map(([v, where]) => `v=${v} ← ${[...new Set(where)].join(', ')}`)
      .join('；');
    failures.push(`[版本分裂] ${base}：${detail}`);
  }
}

if (failures.length) {
  console.error(`✗ 前端缓存击穿契约不通过（${failures.length} 处）：\n`);
  for (const f of failures) console.error('  ' + f);
  console.error('\n规则：改 public 下任何 js 后，其 ?v= 必须全仓同步 +1（含模块互相 import 的级联）。');
  process.exit(1);
}
console.log(`✓ 缓存击穿契约通过：${refs.size} 个本地资源引用全部带版本号且全仓一致`);
