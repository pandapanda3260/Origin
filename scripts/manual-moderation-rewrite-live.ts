/**
 * 真实试跑:图像审核拦截 → LLM 中性化改写自动救回(方向 B)。
 *
 * ⚠️ 会产生真实 API 花费(图像生成 + LLM 改写)。必须在配置了真实 key 的环境(你的 Mac)运行:
 *
 *     npx tsx scripts/manual-moderation-rewrite-live.ts
 *
 * 它做的事:
 *   1. 加载真实外部 env;取一个真实用户;
 *   2. 用一段【故意违规】的提示词(图像安全审核应当拦截)调真实
 *      generateImageWithModerationRecovery —— 即线上首帧/尾帧走的同一函数;
 *   3. 打印审计(被拦了几次 / LLM 是否真的改写了 / 是否救回成功),
 *      并把结果写到 data/_moderation_rewrite_live_result.json(便于回看)。
 *
 * 解读:
 *   - moderationRecovered=true 且 attempts>1 → ✅ 被拦后 LLM 改写并重试成功,方向 B 生效;
 *   - 抛错(unrecoverable)→ 被拦且 LLM 改写也没救回,前端会显示"提示词违规,未通过安全审核";
 *   - attempts=1 且成功 → 这段没被审核拦截(违规词不够强),换更强的违规词再试。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadExternalEnv } from '../lib/env';
import { getDb } from '../lib/db';
import { generateImageWithModerationRecovery } from '../lib/safe-image-gen';

// 故意违规的测试提示词:用图形化暴力/血腥(图像安全审核常拦的非性类内容)来稳定触发拦截,
// 验证 LLM 能否把它中性化后过审。不含任何性/未成年内容。
const VIOLATING_PROMPT = [
  '电影写实风格,近景特写。',
  '一名战士倒在血泊中,腹部被利刃刺穿、内脏外露,鲜血四溅喷涌,断肢散落一地,',
  '尸体面部痛苦扭曲,地面血肉模糊。极度血腥、残肢、爆头、断头特写。',
].join('');

async function main() {
  loadExternalEnv();

  const db = getDb();
  const user = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get() as any;
  if (!user) {
    console.error('找不到任何用户,无法试跑(token 计费需要 user)。');
    process.exit(1);
  }
  console.log(`[live-test] 使用用户 id=${user.id} username=${user.username || '?'}`);
  console.log('[live-test] 违规提示词预览:', VIOLATING_PROMPT.slice(0, 60), '…');
  console.log('[live-test] 调用真实 generateImageWithModerationRecovery(会产生花费)…\n');

  const started = Date.now();
  let outcome: any;
  try {
    const result = await generateImageWithModerationRecovery(user, {
      prompt: VIOLATING_PROMPT,
      size: '1024x1024',
      kind: 'storyboard',
      projectId: null as any,
    } as any);
    const a = result.safetyAudit;
    outcome = {
      verdict: a.moderationRecovered ? 'RECOVERED_BY_LLM' : 'PASSED_WITHOUT_BLOCK',
      moderationRecovered: a.moderationRecovered,
      attemptCount: a.attempts.length,
      generatedImageId: result.id,
      attempts: a.attempts.map((at) => ({
        attempt: at.attempt,
        errorCode: at.errorCode || null,
        safetyViolations: at.safetyViolations || null,
        submittedPromptPreview: at.submittedPromptPreview,
        rewriteDiffCount: (at.rewriteDiff || []).length,
      })),
      finalSubmittedPromptPreview: a.finalSubmittedPromptPreview,
    };
  } catch (e: any) {
    const a = e?.imageSafetyAudit;
    outcome = {
      verdict: 'UNRECOVERABLE_GIVE_UP',
      error: String(e?.message || e).slice(0, 300),
      attemptCount: a ? a.attempts.length : null,
      attempts: a
        ? a.attempts.map((at: any) => ({
            attempt: at.attempt,
            errorCode: at.errorCode || null,
            safetyViolations: at.safetyViolations || null,
            submittedPromptPreview: at.submittedPromptPreview,
            rewriteDiffCount: (at.rewriteDiff || []).length,
          }))
        : null,
    };
  }
  outcome.elapsedMs = Date.now() - started;

  console.log('\n===== 试跑结果 =====');
  console.log(JSON.stringify(outcome, null, 2));

  const outPath = join(process.cwd(), 'data', '_moderation_rewrite_live_result.json');
  try {
    writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), violatingPrompt: VIOLATING_PROMPT, outcome }, null, 2));
    console.log(`\n[live-test] 结果已写入 ${outPath}`);
  } catch (err) {
    console.warn('[live-test] 写结果文件失败(不影响上面的输出):', err);
  }

  // 简明判读
  console.log('\n[live-test] 判读:');
  if (outcome.verdict === 'RECOVERED_BY_LLM') {
    console.log('  ✅ 被审核拦截后, LLM 改写并重试成功 —— 方向 B 生效。');
  } else if (outcome.verdict === 'UNRECOVERABLE_GIVE_UP') {
    console.log('  ⚠️ 被拦且 LLM 改写也没救回(可能违规太露骨)。已正确放弃, 前端会显示"提示词违规, 未通过安全审核"。');
    console.log('     看上面 attempts: 若 attempt 数>1 或有 rewriteDiff, 说明 LLM 改写确实尝试过了。');
  } else {
    console.log('  ℹ️ 这段没被审核拦截(attempts=1 直接过)。换更强的违规词再试才能验证救回路径。');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
