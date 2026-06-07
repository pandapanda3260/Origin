/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * 测试图像审核「LLM 中性化改写」自动救回(方向 B):
 *   - lib/image-safety-rewrite.ts:rewriteImagePromptForModerationLLM
 *       改了/空/同原文/异常 → changed 正确;
 *   - lib/safe-image-gen.ts:generateImageWithModerationRecovery
 *       关键词改写 0 改动时改调 LLM;LLM 改了 → 用新提示词重试并救回;
 *       LLM 第一次没改 → 再请求一次;仍没改 → 放弃抛错并记录原因。
 *
 * 用 ts.transpileModule + vm,按需注入依赖桩(与其它 test:xxx 一致)。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();

function compileTs(relPath) {
  const sourcePath = path.join(root, relPath);
  return ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
}

function loadModule(relPath, stubs) {
  const code = compileTs(relPath);
  const moduleObj = { exports: {} };
  const fakeRequire = (id) => (Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : require(id));
  vm.runInNewContext(
    code,
    { require: fakeRequire, module: moduleObj, exports: moduleObj.exports, console, process },
    { filename: path.join(root, relPath) },
  );
  return moduleObj.exports;
}

function assert(cond, msg) { if (!cond) throw new Error('assert failed: ' + msg); }
function assertEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`assert failed: ${msg}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
}

let pass = 0;
async function test(name, fn) { await fn(); pass += 1; console.log('PASS  ' + name); }

// ---------- image-safety-rewrite ----------
function loadRewrite() {
  return loadModule('lib/image-safety-rewrite.ts', { './llm': { chatComplete: async () => '' } });
}

async function run() {
  const rw = loadRewrite();

  await test('LLM 改写: 返回不同文本 → changed=true', async () => {
    const original = '【主镜头】- 画面：满地跪伏的人群，夕阳下的圣地高台，群像膜拜';
    const rewritten = '【主镜头】- 画面：广场上站着许多人，夕阳下的开阔高台，人群安静伫立';
    const out = await rw.rewriteImagePromptForModerationLLM(null, original, { chatImpl: async () => rewritten });
    assert(out.changed === true, 'changed should be true');
    assert(out.rewrittenPrompt === rewritten, 'rewritten prompt used');
    assertEqual(out.rewriteDiff.length, 1, 'one diff');
    assertEqual(out.visualAnchorDescription.source, 'sanitized', 'source sanitized');
  });

  await test('LLM 改写: 空输出 → changed=false', async () => {
    const out = await rw.rewriteImagePromptForModerationLLM(null, 'X'.repeat(50), { chatImpl: async () => '' });
    assert(out.changed === false, 'changed false on empty');
    assertEqual(out.invalidReason, 'empty', 'empty reason');
  });

  await test('LLM 改写: 与原文相同 → changed=false', async () => {
    const same = 'A'.repeat(50);
    const out = await rw.rewriteImagePromptForModerationLLM(null, same, { chatImpl: async () => same });
    assert(out.changed === false, 'changed false on identical');
    assertEqual(out.invalidReason, 'no_change', 'same reason');
  });

  await test('LLM 改写: 抛错 → changed=false(吞掉异常)', async () => {
    const out = await rw.rewriteImagePromptForModerationLLM(null, 'B'.repeat(50), {
      chatImpl: async () => { throw new Error('llm down'); },
    });
    assert(out.changed === false, 'changed false on throw');
    assertEqual(out.invalidReason, 'llm_error', 'throw reason');
  });

  await test('LLM 改写: 保护区保持原文且硬性禁止可改 → changed=true', async () => {
    const original = [
      '【任务】生成首帧。',
      '【主镜头】',
      '- 画面：满地跪伏的人群，群像膜拜。',
      '【参考图】',
      '- Image 1 = 角色（Alice）- 锁定同一人脸部、服装。',
      '【角色锁定】',
      'Alice: blue coat, calm face',
      '【硬性禁止】',
      '- 禁止字幕。',
    ].join('\n');
    const rewritten = [
      '【任务】生成首帧。',
      '【主镜头】',
      '- 画面：开阔广场上人群安静伫立。',
      '【参考图】',
      '- Image 1 = 角色（Alice）- 锁定同一人脸部、服装。',
      '【角色锁定】',
      'Alice: blue coat, calm face',
      '【硬性禁止】',
      '- 禁止字幕、说明文字。',
    ].join('\n');
    const out = await rw.rewriteImagePromptForModerationLLM(null, original, { chatImpl: async () => rewritten });
    assert(out.changed === true, 'changed true when protected sections are exact');
    assert(out.rewrittenPrompt.includes('禁止字幕、说明文字'), 'hard prohibition can be rewritten');
  });

  await test('LLM 改写: 修改保护区 → changed=false', async () => {
    const original = [
      '【主镜头】',
      '- 画面：满地跪伏的人群。',
      '【参考图】',
      '- Image 1 = 角色（Alice）- 锁定同一人脸部、服装。',
      '【角色锁定】',
      'Alice: blue coat, calm face',
    ].join('\n');
    const rewritten = [
      '【主镜头】',
      '- 画面：人群安静伫立。',
      '【参考图】',
      '- Image 1 = 角色（Alice）- 锁定同一人脸部、服装。',
      '【角色锁定】',
      'Alice: red coat, calm face',
    ].join('\n');
    const out = await rw.rewriteImagePromptForModerationLLM(null, original, { chatImpl: async () => rewritten });
    assert(out.changed === false, 'changed false when protected section changed');
    assertEqual(out.invalidReason, 'protected_section_changed', 'protected section reason');
  });

  await test('LLM 改写: 加回删除区 → changed=false', async () => {
    const original = [
      '【主镜头】',
      '- 画面：满地跪伏的人群。',
      '【硬性禁止】',
      '- 禁止字幕。',
    ].join('\n');
    const rewritten = [
      '【主镜头】',
      '- 画面：人群安静伫立。',
      '【上下文镜头】',
      '- 镜头 2：后续动作。',
      '【硬性禁止】',
      '- 禁止字幕。',
    ].join('\n');
    const out = await rw.rewriteImagePromptForModerationLLM(null, original, { chatImpl: async () => rewritten });
    assert(out.changed === false, 'changed false when forbidden section added');
    assertEqual(out.invalidReason, 'forbidden_section_added', 'forbidden section reason');
  });

  // ---------- safe-image-gen 救回循环 ----------
  function loadSafeGen() {
    return loadModule('lib/safe-image-gen.ts', {
      './image-gen': {
        composeFinalImagePrompt: (input) => String(input.prompt || ''),
        generateImage: async () => ({ id: 'real', url: 'real' }),
      },
      './db': { getDb: () => ({ prepare: () => ({ run: () => {} }) }) },
      './content-sanitize': {
        preflightImageModerationPrompt: () => ({ hits: [], categories: [] }),
        inferImagePromptSafetyHints: () => [],
        extractImageModerationError: (e) => ({
          blocked: /MODERATION/.test(String(e && e.message)),
          safetyViolations: ['unknown'],
          errorCode: 'moderation_blocked',
          requestId: 'req_test',
        }),
        // 关键词改写永远 0 改动 → 强制走 LLM 分支(还原图像审核 unknown 现实)
        rewriteImagePromptForModeration: (prompt) => ({
          rewrittenPrompt: prompt,
          rewriteDiff: [],
          visualAnchorDescription: { originalText: prompt, effectiveText: prompt, source: 'original', rewriteDiff: [] },
        }),
      },
      './content-flags': { recordContentFlag: () => {} },
      './image-safety-rewrite': { rewriteImagePromptForModerationLLM: async () => ({ changed: false, rewrittenPrompt: '', rewriteDiff: [], visualAnchorDescription: {} }) },
    });
  }

  await test('救回: 被拦→LLM改写→第二次成功(moderationRecovered=true)', async () => {
    const sg = loadSafeGen();
    const calls = [];
    let n = 0;
    const result = await sg.generateImageWithModerationRecovery(
      { id: 1 },
      { prompt: '原始提示词内容内容内容', projectId: 'p1' },
      {
        generateImageImpl: async (_u, inp) => {
          calls.push(inp.prompt);
          n += 1;
          if (n === 1) throw new Error('Image API 400 MODERATION blocked');
          return { id: 'img_ok', url: 'http://ok' };
        },
        rewriteLLMImpl: async (_u, prompt) => ({
          changed: true,
          rewrittenPrompt: '中性化后的提示词内容内容',
          rewriteDiff: [{ type: 'full_rewrite', from: prompt, to: '中性化后的提示词内容内容', reason: 'llm', category: 'unknown' }],
          visualAnchorDescription: { originalText: prompt, effectiveText: '中性化后的提示词内容内容', source: 'sanitized', rewriteDiff: [] },
        }),
      },
    );
    assert(result.id === 'img_ok', 'returns the recovered image');
    assert(result.safetyAudit.moderationRecovered === true, 'moderationRecovered true');
    assertEqual(calls[0], '原始提示词内容内容内容', 'attempt0 used original');
    assertEqual(calls[1], '中性化后的提示词内容内容', 'attempt1 used LLM-rewritten prompt');
  });

  await test('救回: LLM 第一次无效→第二次有效→第二次图片提交成功', async () => {
    const sg = loadSafeGen();
    const imageCalls = [];
    let imageN = 0;
    let rewriteN = 0;
    const result = await sg.generateImageWithModerationRecovery(
      { id: 1 },
      { prompt: '原始提示词内容内容内容', projectId: 'p1' },
      {
        generateImageImpl: async (_u, inp) => {
          imageCalls.push(inp.prompt);
          imageN += 1;
          if (imageN === 1) throw new Error('Image API 400 MODERATION blocked');
          return { id: 'img_ok_after_retry', url: 'http://ok' };
        },
        rewriteLLMImpl: async (_u, prompt) => {
          rewriteN += 1;
          if (rewriteN === 1) {
            return { changed: false, invalidReason: 'no_change', rewrittenPrompt: prompt, rewriteDiff: [], visualAnchorDescription: {} };
          }
          return {
            changed: true,
            rewrittenPrompt: '第二次 LLM 有效改写内容内容',
            rewriteDiff: [{ type: 'full_rewrite', from: prompt, to: '第二次 LLM 有效改写内容内容', reason: 'llm', category: 'unknown' }],
            visualAnchorDescription: { originalText: prompt, effectiveText: '第二次 LLM 有效改写内容内容', source: 'sanitized', rewriteDiff: [] },
          };
        },
      },
    );
    assert(result.id === 'img_ok_after_retry', 'returns recovered image');
    assertEqual(rewriteN, 2, 'LLM should be requested twice when first rewrite is invalid');
    assertEqual(imageCalls, ['原始提示词内容内容内容', '第二次 LLM 有效改写内容内容'], 'second image call uses second LLM rewrite');
    assertEqual(result.safetyAudit.attempts[0].rewriteAttemptNotes.length, 2, 'audit records both LLM rewrite attempts');
    assertEqual(result.safetyAudit.attempts[0].rewriteAttemptNotes[0].invalidReason, 'no_change', 'audit records first invalid reason');
  });

  await test('救回: 连续两次图片审核拦截 → 提交原稿、改写稿1、改写稿2', async () => {
    const sg = loadSafeGen();
    const imageCalls = [];
    let rewriteN = 0;
    const result = await sg.generateImageWithModerationRecovery(
      { id: 1 },
      { prompt: '原始提示词内容内容内容', projectId: 'p1' },
      {
        generateImageImpl: async (_u, inp) => {
          imageCalls.push(inp.prompt);
          if (imageCalls.length <= 2) throw new Error('Image API 400 MODERATION blocked');
          return { id: 'img_ok_third', url: 'http://ok' };
        },
        rewriteLLMImpl: async (_u, prompt) => {
          rewriteN += 1;
          const rewritten = `有效改写稿${rewriteN}：${prompt}`;
          return {
            changed: true,
            rewrittenPrompt: rewritten,
            rewriteDiff: [{ type: 'full_rewrite', from: prompt, to: rewritten, reason: 'llm', category: 'unknown' }],
            visualAnchorDescription: { originalText: prompt, effectiveText: rewritten, source: 'sanitized', rewriteDiff: [] },
          };
        },
      },
    );
    assert(result.id === 'img_ok_third', 'returns recovered image after third image attempt');
    assertEqual(imageCalls.length, 3, 'should submit original plus two rewritten prompts');
    assertEqual(imageCalls[0], '原始提示词内容内容内容', 'attempt0 original');
    assert(imageCalls[1].startsWith('有效改写稿1：'), 'attempt1 first rewrite');
    assert(imageCalls[2].startsWith('有效改写稿2：'), 'attempt2 second rewrite');
  });

  await test('放弃: LLM 连续两次也没改 → 抛错并记录原因', async () => {
    const sg = loadSafeGen();
    let n = 0;
    let rewriteN = 0;
    let threw = false;
    let thrown = null;
    try {
      await sg.generateImageWithModerationRecovery(
        { id: 1 },
        { prompt: '原始提示词内容内容内容', projectId: 'p1' },
        {
          generateImageImpl: async () => { n += 1; throw new Error('Image API 400 MODERATION blocked'); },
          rewriteLLMImpl: async () => {
            rewriteN += 1;
            return { changed: false, invalidReason: 'no_change', rewrittenPrompt: '', rewriteDiff: [], visualAnchorDescription: {} };
          },
        },
      );
    } catch (e) {
      threw = true;
      thrown = e;
    }
    assert(threw, 'should throw when unrecoverable');
    assertEqual(n, 1, 'only one image attempt without an effective rewrite');
    assertEqual(rewriteN, 2, 'LLM should be retried once before giving up');
    assertEqual(thrown.imageSafetyAudit.attempts[0].rewriteFailureReason, 'rewrite_failed:no_change', 'audit records rewrite failure reason');
  });

  console.log(`\n${pass}/${pass} passed`);
}

run().catch((e) => { console.error(e); process.exit(1); });
