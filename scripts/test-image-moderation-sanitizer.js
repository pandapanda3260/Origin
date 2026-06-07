const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();
const sourcePath = path.join(root, 'lib/content-sanitize.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    resolveJsonModule: true,
  },
  fileName: sourcePath,
}).outputText;

function localRequire(id) {
  if (id === '../config/image-sanitize-rules.json') {
    return require(path.join(root, 'config/image-sanitize-rules.json'));
  }
  return require(id);
}

function loadContentSanitizeModule(envPatch = {}) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(envPatch)) {
    previousEnv[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }

  try {
    const moduleObj = { exports: {} };
    vm.runInNewContext(compiled, {
      require: localRequire,
      module: moduleObj,
      exports: moduleObj.exports,
      console,
    }, { filename: sourcePath });
    return moduleObj.exports;
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const {
  extractImageModerationError,
  inferImagePromptSafetyHints,
  preflightImageModerationPrompt,
  rewriteImagePromptForModeration,
} = loadContentSanitizeModule();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const cases = [
  {
    name: 'prop dark fur false positive',
    category: 'sexual',
    input: '金箍棒棒尖挂着一缕黑毛，金属表面有战斗划痕与烟尘。',
    expected: '棒尖有一缕深色布料纤维残留',
  },
  {
    name: 'surface fur residue on clothing',
    category: 'sexual',
    input: '衣角沾着几根毛发，石阶上有烟尘。',
    expected: '衣角有一缕深色布料纤维残留',
  },
  {
    name: 'english fur residue',
    category: 'sexual',
    input: 'tiny black fur snagged on one end of the staff, faint soot on metal.',
    expected: 'dark fabric fibers caught near the tip',
  },
  {
    name: 'fallen creature aftermath',
    category: 'violence',
    input: '被打晕的小妖灰绿身影软塌塌倒在雾后，像战后直播复盘的荒诞背景。',
    expected: '远处雾后留下模糊的战后轮廓与散落道具',
  },
  {
    name: 'loose robe not exposed body',
    category: 'sexual',
    input: '猪八戒灰蓝粗布僧袍半敞，圆胖身子贴近镜头。',
    expected: '衣袍松垮但完整覆盖身体',
  },
];

const negativeCases = [
  {
    name: 'black-haired pig species feature',
    input: '一只黑毛猪站在石径旁，粗布衣服完整覆盖身体。',
  },
  {
    name: 'black-haired dog species feature',
    input: '黑毛狗在雾里跑过，身上没有任何道具残留。',
  },
  {
    name: 'sun wukong body hair feature',
    input: 'CHARACTER LOCK:\n孙悟空: 棕金短毛猕猴，脸颊黑毛，金眼锐利。\nPROP LOCK:\n金箍棒金属表面有烟尘。',
  },
  {
    name: 'zhu bajie body hair feature',
    input: '猪八戒耳后短毛清晰，蓝灰僧衣完整覆盖身体。',
  },
];

for (const item of cases) {
  const preflight = preflightImageModerationPrompt(item.input);
  assert(preflight.hits.length > 0, `${item.name}: expected preflight hit`);
  const rewrite = rewriteImagePromptForModeration(item.input, [item.category]);
  assert(rewrite.rewrittenPrompt.includes(item.expected), `${item.name}: expected replacement "${item.expected}"`);
  assert(rewrite.rewriteDiff.length > 0, `${item.name}: expected rewrite diff`);
  assert(rewrite.visualAnchorDescription.source === 'sanitized', `${item.name}: expected sanitized visual anchor`);
  assert(rewrite.rewriteDiff.some((diff) => diff.slot), `${item.name}: expected semantic slot on rewrite diff`);
}

for (const item of negativeCases) {
  const preflight = preflightImageModerationPrompt(item.input);
  const rewrite = rewriteImagePromptForModeration(item.input, ['sexual']);
  assert(preflight.hits.length === 0, `${item.name}: expected no preflight hit in protected/body-feature text`);
  assert(rewrite.rewrittenPrompt === item.input, `${item.name}: expected no rewrite`);
  assert(rewrite.rewriteDiff.length === 0, `${item.name}: expected no rewrite diff`);
}

const openAiPolicyError = extractImageModerationError(
  new Error('Image API 400: {"error":{"code":"content_policy_violation","message":"Your image request was rejected.","request_id":"req_AbC123_xYz"}}'),
);
assert(openAiPolicyError.blocked, 'content_policy_violation should be blocked');
assert(openAiPolicyError.requestId === 'req_AbC123_xYz', 'req_ request id should be parsed');

const safetyRejection = extractImageModerationError(
  new Error('Image API 400: safety rejection from upstream request ID 7e8782e2-90cc-425b-ac7c-8f00b2f34438'),
);
assert(safetyRejection.blocked, 'safety rejection should be blocked');
assert(safetyRejection.requestId === '7e8782e2-90cc-425b-ac7c-8f00b2f34438', 'uuid request id should be parsed');

const chinesePolicyError = extractImageModerationError(
  new Error('Image API 400: {"error":{"code":"image_generation_user_error","message":"内容不符合安全政策，违反内容审核规则，请修改后重试","request_id":"req_cnSafe123"}}'),
);
assert(chinesePolicyError.blocked, 'Chinese content safety policy error should be blocked');
assert(chinesePolicyError.requestId === 'req_cnSafe123', 'Chinese gateway req_ request id should be parsed');

const chineseSafetySystemRejection = extractImageModerationError(
  new Error('Image API 400: {"error":{"message":"请求被安全系统拒绝：未通过安全审核","request_id":"req_cnReject456"}}'),
);
assert(chineseSafetySystemRejection.blocked, 'Chinese safety system rejection should be blocked');

const preflight = preflightImageModerationPrompt('金箍棒棒尖挂着一缕黑毛。');
const fallbackPolicy = extractImageModerationError(
  new Error('Image API 422: {"error":{"type":"image_generation_user_error","message":"blocked by upstream"}}'),
  { preflight },
);
assert(fallbackPolicy.blocked, '400/422 plus risky preflight should fallback to moderation rewrite');

const parameterError = extractImageModerationError(
  new Error('Image API 400: {"error":{"code":"invalid_request_error","message":"invalid size parameter"}}'),
  { preflight },
);
assert(!parameterError.blocked, 'parameter errors should not be treated as moderation');

const chineseParameterError = extractImageModerationError(
  new Error('Image API 400: {"error":{"message":"请求参数无效：size 参数错误"}}'),
  { preflight },
);
assert(!chineseParameterError.blocked, 'Chinese parameter errors should not be treated as moderation');

const normalExplanation = extractImageModerationError(
  new Error('Image API 400: {"error":{"message":"说明：该内容不违反版权，系统拒绝生成低质内容"}}'),
);
assert(!normalExplanation.blocked, 'unanchored Chinese words should not be treated as moderation');

const hints = inferImagePromptSafetyHints(
  '广场前排的圆脸少年被金光照得脸色发白，惊惧地仰头。金色符文从指缝喷薄而出，画面像定格的引信。',
);
assert(hints.length >= 2, 'safety hints should flag fear and impact imagery');
assert(hints.some((hint) => hint.text.includes('脸色发白') || hint.text.includes('惊惧')), 'safety hints should include fear phrasing');
assert(hints.some((hint) => hint.text.includes('喷薄') || hint.text.includes('引信')), 'safety hints should include impact phrasing');

const degradedModule = loadContentSanitizeModule({
  IMAGE_SANITIZE_RULES_PATH: path.join(root, '.missing-image-sanitize-rules.json'),
});
const degradedInput = '金箍棒棒尖挂着一缕黑毛。';
assert(
  degradedModule.preflightImageModerationPrompt(degradedInput).hits.length === 0,
  'missing rule file should degrade to empty preflight rules',
);
assert(
  degradedModule.rewriteImagePromptForModeration(degradedInput, ['sexual']).rewrittenPrompt === degradedInput,
  'missing rule file should degrade to no-op rewrite',
);

console.log(`image moderation sanitizer ok (${cases.length} cases)`);
