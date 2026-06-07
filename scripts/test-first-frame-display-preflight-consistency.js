/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 回归测试 (字段对齐方案 选项 A): 首帧"显示口径"与"尾帧预检口径"必须一致。
 *
 * 不变式: 对任意 storyboard,
 *     firstFrameImageUrl(sb) 为空  ⟺  checkTailFramePreflight(sb).reason === 'missing_first_frame'
 *
 * 即"图能看到" ⟺ "预检不判 missing_first_frame", 杜绝"图能看到却报首帧未就绪"。
 *
 * - checkTailFramePreflight 用真实 TS (ts.transpileModule + vm), 和其它 test 一致。
 * - firstFrameImageUrl 从 public/modules/frameRecommendations.js 源码里按花括号配平提取真函数,
 *   不做手抄复刻, 保证测到的是线上代码。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();

function loadCheckTailFramePreflight() {
  const p = path.join(root, 'lib/visual-reference-state.ts');
  const code = ts.transpileModule(fs.readFileSync(p, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: p,
  }).outputText;
  const moduleObj = { exports: {} };
  vm.runInNewContext(code, { require, module: moduleObj, exports: moduleObj.exports, console, process }, { filename: p });
  return moduleObj.exports.checkTailFramePreflight;
}

// 从源码里按花括号配平提取一个具名函数, 返回可调用的真实函数。
function extractFunction(srcPath, fnName) {
  const src = fs.readFileSync(path.join(root, srcPath), 'utf8');
  const sig = 'function ' + fnName + '(';
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('找不到函数 ' + fnName);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceOpen; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('花括号未配平: ' + fnName);
  const fnSrc = src.slice(start, end + 1);
  // 函数体只用到入参 sb, 无外部依赖; 用 Function 包出来。
  return new Function(fnSrc + '\nreturn ' + fnName + ';')();
}

function assert(cond, msg) { if (!cond) throw new Error('assert failed: ' + msg); }

const checkTailFramePreflight = loadCheckTailFramePreflight();
const _firstFrameImageUrl = extractFunction('public/modules/frameRecommendations.js', 'firstFrameImageUrl');

function isMissing(sb) {
  const err = checkTailFramePreflight(sb);
  return !!(err && err.reason === 'missing_first_frame');
}
function displayEmpty(sb) {
  return !_firstFrameImageUrl(sb);
}

let pass = 0;
let fail = 0;
function checkConsistency(label, sb, expectMissing) {
  const de = displayEmpty(sb);
  const miss = isMissing(sb);
  const consistent = de === miss;
  const expOk = expectMissing === undefined || miss === expectMissing;
  if (consistent && expOk) {
    pass += 1;
    console.log(`PASS  ${label}  (displayEmpty=${de}, missing=${miss})`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}  displayEmpty=${de} missing=${miss}` +
      (expectMissing !== undefined ? ` expectMissing=${expectMissing}` : ''));
  }
}

// ---- 合成边界用例 ----
// 旧 bug 场景: 只有通用图字段 → 收紧后显示应为空, 预检 missing, 两者一致。
checkConsistency('只有 url(通用图)', { url: '/api/images/file/x' }, true);
checkConsistency('只有 imageUrl', { imageUrl: '/api/images/file/x' }, true);
checkConsistency('只有 rawUrl', { rawUrl: '/api/images/file/x' }, true);
checkConsistency('url+imageUrl+rawUrl 都有但无首帧字段', { url: 'a', imageUrl: 'a', rawUrl: 'a' }, true);
// 空 → 都判无首帧。
checkConsistency('空 storyboard', {}, true);
// 合格首帧的各种字段来源 → 显示有图 + 非 missing。
checkConsistency('firstFrameUrl + structured_v1', { firstFrameUrl: 'a', firstFrameMode: 'structured_v1' }, false);
checkConsistency('frames.first.url + ready', { frames: { first: { url: 'a', status: 'ready' } } }, false);
checkConsistency('firstFrame.currentUrl + structured_v1', { firstFrame: { currentUrl: 'a' }, firstFrameMode: 'structured_v1' }, false);
// legacy_pencil: 有首帧URL → 显示有图, 预检判 invalid_first_frame_mode(非 missing) → 一致。
checkConsistency('legacy_pencil(有图,非missing)', { firstFrameUrl: 'a', firstFrameMode: 'legacy_pencil', firstFrame: { status: 'legacy_sketch_only' } }, false);

// ---- 真实项目数据(若已 dump) ----
const dump = '/tmp/sbs.json';
if (fs.existsSync(dump)) {
  const sbs = JSON.parse(fs.readFileSync(dump, 'utf8'));
  sbs.forEach((sb, i) => checkConsistency(`真实数据 storyboards[${i}]`, sb));
} else {
  console.log('(跳过真实项目数据: 未找到 ' + dump + ')');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
