#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = function compileTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const {
  buildMentionResolverBenchmarkFixture,
  evaluateMentionResolver,
} = require(path.join(process.cwd(), 'lib', 'character-mention-resolver.ts'));

const minPrecision = Number(process.env.MENTION_RESOLVER_MIN_PRECISION || 0.95);
const minRecall = Number(process.env.MENTION_RESOLVER_MIN_RECALL || 0.85);
const { characters, cases } = buildMentionResolverBenchmarkFixture();
const result = evaluateMentionResolver(cases, characters);

const summary = {
  precisionTarget: minPrecision,
  recallTarget: minRecall,
  ...result,
};

console.log(JSON.stringify(summary, null, 2));

if (result.precision < minPrecision || result.recall < minRecall) {
  console.error(
    `Mention resolver benchmark failed: precision=${result.precision.toFixed(3)}, recall=${result.recall.toFixed(3)}`,
  );
  process.exit(1);
}
