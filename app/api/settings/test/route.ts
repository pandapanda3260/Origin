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
import { resolveLLMConfig } from '@/lib/llm';
import { jsonOk, jsonError } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Slot = 'text' | 'image' | 'video' | 'storyboard';

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) return jsonError('unauthorized', 401);

  const body = await req.json().catch(() => ({} as any));
  const slot = (body.slot || 'text') as Slot;
  const cfg = resolveLLMConfig(user, slot);

  if (cfg.mode === 'fake' || !cfg.apiKey) {
    return jsonOk({
      ok: false,
      error: '尚未配置 API Key',
      hint: '请到 API 配置中心填写 ' + slot + ' 槽位的 API 地址、Key 和模型名',
    });
  }

  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        temperature: 0,
      }),
    });
  } catch (e: any) {
    return jsonOk({
      ok: false,
      error: '网络请求失败：' + (e?.message || String(e)),
      hint: '检查 API 地址是否可访问、是否需要 /v1 后缀、本机网络是否可达',
    });
  }
  const latencyMs = Date.now() - t0;

  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).slice(0, 300);
    return jsonOk({
      ok: false,
      error: `HTTP ${resp.status}`,
      hint: text || '检查 Key 是否正确、模型名是否被服务商支持',
      latencyMs,
    });
  }

  let json: any = null;
  try {
    json = await resp.json();
  } catch (e: any) {
    return jsonOk({
      ok: false,
      error: '响应不是 JSON',
      hint: '该 API 地址可能不是 OpenAI 兼容协议',
      latencyMs,
    });
  }

  const reply = (json?.choices?.[0]?.message?.content || '').toString().slice(0, 80);
  return jsonOk({
    ok: true,
    model: cfg.model,
    reply: reply || '(模型返回为空，但 HTTP 200，连接正常)',
    latencyMs,
    source: cfg.source,
  });
}
