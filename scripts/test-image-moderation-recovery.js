const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();

function compileTs(relPath) {
  const sourcePath = path.join(root, relPath);
  return {
    sourcePath,
    code: ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
      fileName: sourcePath,
    }).outputText,
  };
}

function loadContentSanitize() {
  const compiled = compileTs('lib/content-sanitize.ts');
  const moduleObj = { exports: {} };
  vm.runInNewContext(compiled.code, {
    require,
    module: moduleObj,
    exports: moduleObj.exports,
    console,
    process,
  }, { filename: compiled.sourcePath });
  return moduleObj.exports;
}

function loadSafeImageGen(contentSanitize) {
  const compiled = compileTs('lib/safe-image-gen.ts');
  const moduleObj = { exports: {} };
  function localRequire(id) {
    if (id === './content-sanitize') return contentSanitize;
    if (id === './content-flags') return { recordContentFlag: () => null };
    if (id === './image-safety-rewrite') {
      return {
        rewriteImagePromptForModerationLLM: async (_user, prompt) => ({
          changed: false,
          rewrittenPrompt: prompt,
          rewriteDiff: [],
          visualAnchorDescription: {
            originalText: prompt,
            effectiveText: prompt,
            source: 'original',
            rewriteDiff: [],
          },
        }),
      };
    }
    if (id === './image-gen') {
      return {
        generateImage: async () => { throw new Error('test should inject generateImageImpl'); },
        composeFinalImagePrompt: (input) => `${input.prompt}\n\nSTYLE_SUFFIX_AUDIT_ONLY`,
      };
    }
    if (id === './db') {
      return {
        getDb: () => ({
          prepare: () => ({ run: () => undefined }),
        }),
      };
    }
    return require(id);
  }
  vm.runInNewContext(compiled.code, {
    require: localRequire,
    module: moduleObj,
    exports: moduleObj.exports,
    console,
  }, { filename: compiled.sourcePath });
  return moduleObj.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function moderationError(category, requestId) {
  return new Error(
    `Image API 400: {"error":{"code":"content_policy_violation","message":"blocked","safety_violations":["${category}"],"request_id":"${requestId}"}}`,
  );
}

async function main() {
  const contentSanitize = loadContentSanitize();
  const { generateImageWithModerationRecovery } = loadSafeImageGen(contentSanitize);
  const user = { id: 1 };
  const baseInput = {
    prompt: '',
    kind: 'prop',
    style: 'natural',
    projectId: 'proj_test',
    assetRef: 'props[0]',
  };

  {
    const calls = [];
    const result = await generateImageWithModerationRecovery(
      user,
      { ...baseInput, prompt: '猪八戒袒胸站在石阶。' },
      {
        generateImageImpl: async (_user, input) => {
          calls.push(input);
          if (calls.length === 1) throw moderationError('sexual', 'req_recover_1');
          return { id: 'img_recovered', url: '/api/images/file/img_recovered', width: 1, height: 1, bytes: 1, mode: 'fake' };
        },
      },
    );
    assert(calls.length === 2, 'moderation recovery should retry once after rewrite');
    assert(calls[1].prompt.includes('衣袍松垮但完整覆盖身体'), 'sexual rewrite should sanitize retry prompt');
    assert(result.safetyAudit.moderationRecovered === true, 'successful retry should mark moderationRecovered');
    assert(result.safetyAudit.generatedImageId === 'img_recovered', 'successful retry should record generatedImageId');
    assert(result.safetyAudit.attempts.length === 2, 'successful retry audit should contain two attempts');
    assert(result.safetyAudit.attempts[0].submittedPromptHash, 'compact attempt should include prompt hash');
    assert(!Object.prototype.hasOwnProperty.call(result.safetyAudit.attempts[0], 'submittedPrompt'), 'compact attempt should not include full prompt');
    assert(result.safetyAudit.finalComposedPromptHash, 'audit should include final composed prompt hash');
  }

  {
    const calls = [];
    let thrown = null;
    try {
      await generateImageWithModerationRecovery(
        user,
        { ...baseInput, prompt: '猪八戒袒胸，被打晕的小妖倒在雾后。' },
        {
          generateImageImpl: async (_user, input) => {
            calls.push(input);
            if (calls.length === 1) throw moderationError('sexual', 'req_fail_1');
            if (calls.length === 2) throw moderationError('violence', 'req_fail_2');
            throw moderationError('violence', 'req_fail_3');
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    assert(thrown, 'repeated moderation failure should throw');
    assert(calls.length === 3, 'repeated moderation failure should submit original plus two retries');
    assert(thrown.imageSafetyAudit?.attempts?.length === 3, 'failed audit should preserve three compact attempts');
    assert(thrown.imageSafetyAudit?.moderationRecovered === false, 'failed recovery should not mark moderationRecovered');
  }

  {
    const calls = [];
    let thrown = null;
    try {
      await generateImageWithModerationRecovery(
        user,
        { ...baseInput, prompt: '金箍棒棒尖挂着一缕黑毛。' },
        {
          generateImageImpl: async (_user, input) => {
            calls.push(input);
            throw new Error('Image API 400: {"error":{"code":"invalid_request_error","message":"invalid size parameter"}}');
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    assert(thrown, 'parameter error should throw');
    assert(calls.length === 1, 'parameter error should not trigger moderation rewrite');
    assert(thrown.imageSafetyAudit?.attempts?.length === 1, 'parameter error audit should contain one attempt');
  }

  // P3a: retry 必须把 referenceImagePaths 完整透传, 不能因 prompt 改写而丢图。
  {
    const calls = [];
    const paths = ['/local/scene.png', '/local/alice.png', '/local/lantern.png'];
    const result = await generateImageWithModerationRecovery(
      user,
      { ...baseInput, prompt: '猪八戒袒胸站在石阶。', referenceImagePaths: paths },
      {
        generateImageImpl: async (_user, input) => {
          calls.push(input);
          if (calls.length === 1) throw moderationError('sexual', 'req_multi_1');
          return { id: 'img_multi_recovered', url: '/api/images/file/img_multi_recovered', width: 1, height: 1, bytes: 1, mode: 'fake' };
        },
      },
    );
    assert(calls.length === 2, 'multi-ref retry should reach generateImage twice');
    assert(Array.isArray(calls[0].referenceImagePaths), 'first call receives the array');
    assert(calls[0].referenceImagePaths.length === 3, 'first call has 3 refs');
    assert(Array.isArray(calls[1].referenceImagePaths), 'retry still receives the array (not dropped)');
    assert(calls[1].referenceImagePaths.length === 3, 'retry preserves all 3 refs');
    for (let i = 0; i < 3; i += 1) {
      assert(
        calls[0].referenceImagePaths[i] === calls[1].referenceImagePaths[i]
          && calls[1].referenceImagePaths[i] === paths[i],
        `retry ref[${i}] should be identical to original`,
      );
    }
    assert(result.safetyAudit.moderationRecovered === true, 'multi-ref recovery should still succeed');
  }

  console.log('image moderation recovery ok (4 scenarios)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
