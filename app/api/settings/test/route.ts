/**
 * 真去 ping 一次模型，确认 baseUrl + apiKey + model 拼起来能跑。
 *
 * 前端 public/modules/settings.js 的"测试连接"按钮会按槽位（image / video）轮流 POST 过来。
 * 我们这里支持任意 slot（text / image / video / storyboard）——image / video 两种生成模型
 * 通常都是 OpenAI 兼容的 chat 端点延伸出去的，所以用 chat/completions 探活即可识别 key 是否可用。
 *
 * 返回契约（与 settings.js 期望一致）：
 *   成功： { ok: true,  model, reply, latencyMs }
 *   失败： { ok: false, error, hint }
 */
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { chatComplete } from '@/lib/llm';
import { resolveSlotModelConfig, resolveTextModelConfig, type TextModelRole } from '@/lib/model-routing';
import { jsonOk, jsonError } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Slot = 'text' | 'brain' | 'structured' | 'image' | 'video' | 'storyboard';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const slot = (body.slot || 'text') as Slot;
  const isTextSlot = slot === 'text' || slot === 'brain' || slot === 'structured';
  const role: TextModelRole = slot === 'structured' ? 'structured' : 'brain';
  const cfg = isTextSlot
    ? resolveTextModelConfig(user, role)
    : resolveSlotModelConfig(user, slot);

  if (cfg.mode === 'fake' || !cfg.apiKey) {
    return jsonOk({
      ok: false,
      error: '尚未配置 API Key',
      hint: '请到 API 配置中心填写 ' + slot + ' 槽位的 API 地址、Key 和模型名',
    });
  }

  if (!isTextSlot) {
    return jsonOk({
      ok: true,
      model: cfg.model,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      source: cfg.source,
      reply: `${slot} 配置已读取；为避免扣费，本测试不发起真实生成任务`,
      checked: 'config-only',
    });
  }

  const t0 = Date.now();
  let reply = '';
  try {
    reply = await chatComplete(
      user,
      [{ role: 'user', content: 'ping，回复 pong 即可。' }],
      { temperature: 0, maxTokens: role === 'structured' ? 256 : 64, modelRole: role },
    );
  } catch (e: any) {
    return jsonOk({
      ok: false,
      error: '模型请求失败：' + (e?.message || String(e)),
      hint: '检查 API 地址、Key、模型名、provider endpoint 是否匹配',
      latencyMs: Date.now() - t0,
      provider: cfg.provider,
      model: cfg.model,
      source: cfg.source,
    });
  }
  const latencyMs = Date.now() - t0;

  return jsonOk({
    ok: true,
    model: cfg.model,
    provider: cfg.provider,
    reply: reply || '(模型返回为空，但 HTTP 200，连接正常)',
    latencyMs,
    source: cfg.source,
  });
}
