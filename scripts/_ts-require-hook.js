/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 透明 TS require hook (CJS): 让 require('../lib/foo.ts') / require('../lib/foo')
 * 都能加载并在线编译 .ts 文件。
 *
 * 实现:
 *   1. 用 require.extensions['.ts'] 注册编译钩子, ts.transpileModule 现编现跑;
 *   2. 同时拦截 require, 把没后缀的相对路径 (..//lib/foo) 尝试加 .ts 解析,
 *      绕过 Node 默认只找 .js / .json 的限制。
 *
 * 用于本仓库的集成测试; 不进生产链路。
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      resolveJsonModule: true,
      jsx: ts.JsxEmit.Preserve,
      experimentalDecorators: true,
      allowJs: true,
    },
    fileName: filename,
  });
  // eslint-disable-next-line no-underscore-dangle
  module._compile(out.outputText, filename);
};

// 拦 _resolveFilename: 让没后缀的相对/绝对路径若命中 .ts 文件就用它,
// 并支持 @/ alias 指向项目根目录 (tsconfig.paths 风格)。
const PROJECT_ROOT = path.resolve(__dirname, '..');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  let req = request;
  if (req.startsWith('@/')) {
    req = path.join(PROJECT_ROOT, req.slice(2));
  }
  // 直接试一遍原解析
  try {
    return origResolve.call(this, req, parent, ...rest);
  } catch (err) {
    // 兜底: 尝试 .ts / /index.ts
    const candidates = [];
    if (req.startsWith('.') || path.isAbsolute(req)) {
      const base = path.isAbsolute(req)
        ? req
        : path.resolve(parent ? path.dirname(parent.filename) : process.cwd(), req);
      candidates.push(base + '.ts');
      candidates.push(path.join(base, 'index.ts'));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw err;
  }
};
