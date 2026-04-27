/**
 * 统一 LLM 调用层（OpenAI 兼容协议）
 *
 * 设计原则：
 *   - Key / baseUrl / model 三件套优先从用户 settings 表读，未配置则回落到环境变量，
 *     最后兜底用一个"无 Key 假回复"模式（开发环境零成本试跑）
 *   - 同时支持流式（SSE）和非流式
 *   - 流式时把 OpenAI 的 delta.content 转成我们前端约定的 {type:'chunk',content}
 *     和最终 {type:'done', ...} 两种事件
 *   - 失败时抛带 friendly message 的 Error，路由层会序列化成前端能展示的中文
 */

import type { UserRow } from './db';
import { getJson } from './kv-db';
import { MOCK_USER_SETTINGS } from '@/mocks/settings';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
};

export type LLMOptions = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: 'text' | 'json_object';
  // 覆盖默认模型选择（默认用 settings 里的 text 模型）
  modelOverride?: string;
};

export type LLMResolved = {
  baseUrl: string;
  apiKey: string;
  model: string;
  // 'real' = 真调，'fake' = 内置假回复（用户没配 Key）
  mode: 'real' | 'fake';
  source: 'user-settings' | 'env' | 'fallback';
};

const FAKE_NOTE = '[本地无 Key 假回复] 这条内容来自占位生成，请到设置页填入 OpenAI 兼容 API Key 后再试。';

/**
 * 读用户的 LLM 配置：优先 user_settings.models.text → 环境变量 → fake 兜底
 */
export function resolveLLMConfig(
  user: UserRow | null,
  slot: 'text' | 'image' | 'video' | 'storyboard' = 'text',
): LLMResolved {
  let baseUrl = '';
  let apiKey = '';
  let model = '';
  let source: LLMResolved['source'] = 'fallback';

  if (user) {
    try {
      const s: any = getJson('user_settings', user.id, MOCK_USER_SETTINGS);
      const slotCfg = (s && s.models && s.models[slot]) || {};
      if (slotCfg.apiKey) {
        baseUrl = String(slotCfg.baseUrl || '').trim();
        apiKey = String(slotCfg.apiKey || '').trim();
        model = String(slotCfg.model || '').trim();
        source = 'user-settings';
      }
    } catch (_) {
      // ignore
    }
  }

  if (!apiKey) {
    const envKey = process.env.OPENAI_API_KEY || '';
    const envBase = process.env.OPENAI_BASE_URL || '';
    const envModel = process.env.OPENAI_MODEL || '';
    if (envKey) {
      apiKey = envKey;
      baseUrl = envBase || baseUrl;
      model = envModel || model;
      source = 'env';
    }
  }

  if (!baseUrl) baseUrl = 'https://api.openai.com/v1';
  if (!model) {
    if (slot === 'image') model = 'gpt-image-1';
    else if (slot === 'video') model = 'sora';
    else model = 'gpt-4o-mini';
  }

  if (apiKey) {
    return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, mode: 'real', source };
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: '', model, mode: 'fake', source: 'fallback' };
}

/* ============================================================
   非流式调用：拿一个完整字符串
   ============================================================ */
export async function chatComplete(
  user: UserRow | null,
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  const cfg = resolveLLMConfig(user);
  if (cfg.mode === 'fake') {
    return fakeReply(messages, opts);
  }

  const body: any = {
    model: opts.modelOverride || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.topP ?? 1,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.stop) body.stop = opts.stop;
  if (opts.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM 返回结构异常（缺 message.content）');
  return content;
}

/* ============================================================
   流式调用：把 OpenAI 的 delta.content 一段段流回 onChunk
   ============================================================ */
export async function chatStream(
  user: UserRow | null,
  messages: ChatMessage[],
  opts: LLMOptions = {},
  onChunk: (text: string) => void,
): Promise<string> {
  const cfg = resolveLLMConfig(user);
  if (cfg.mode === 'fake') {
    const text = fakeReply(messages, opts);
    // 假装"流式"：每 12 字符 + 一点延迟推一下
    let i = 0;
    while (i < text.length) {
      const chunk = text.slice(i, i + 12);
      onChunk(chunk);
      i += 12;
      await new Promise((r) => setTimeout(r, 30));
    }
    return text;
  }

  const body: any = {
    model: opts.modelOverride || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.topP ?? 1,
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
  };
  if (opts.stop) body.stop = opts.stop;
  if (opts.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM ${resp.status}: ${text.slice(0, 500)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return full;
      try {
        const evt: any = JSON.parse(payload);
        const delta = evt?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          full += delta;
          onChunk(delta);
        }
      } catch {
        // ignore parse errors on heartbeat lines
      }
    }
  }
  return full;
}

/* ============================================================
   假回复：用户没配 Key 时让代码"能跑通"，方便 phase 2 在你拿到
   Key 之前先做端到端联调
   ============================================================ */
function fakeReply(messages: ChatMessage[], opts: LLMOptions = {}): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const isJson = opts.responseFormat === 'json_object';

  if (isJson) {
    // 根据 system 中的 schema hint 回返一个安全的占位 JSON
    return JSON.stringify({
      ok: true,
      mock: true,
      note: FAKE_NOTE,
      echo: lastUser.slice(0, 80),
    });
  }

  return [
    `${FAKE_NOTE}`,
    '',
    `用户输入：${lastUser.slice(0, 200)}${lastUser.length > 200 ? '…' : ''}`,
    '',
    '【铺垫】这里会展开背景与人物初亮相。',
    '【升温】事件发酵，主角开始行动。',
    '【高潮】冲突达到顶点，关键抉择出现。',
    '【回落】余波荡漾，结果显现。',
    '【余韵】留白与回味，画面慢慢淡出。',
  ].join('\n');
}

/* ============================================================
   工具：从 LLM 文本中尽量稳健地解析 JSON
   ============================================================ */
export function parseJsonLoose<T = any>(raw: string): T {
  if (!raw) throw new Error('LLM 返回空');
  let text = raw.trim();
  // 去掉 markdown 代码围栏
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }
  // 截取首个 { 到末个 }
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i >= 0 && j > i) text = text.slice(i, j + 1);
  try {
    return JSON.parse(text);
  } catch (e) {
    // 尝试修一些常见错误：行尾逗号 / 单引号
    const fixed = text
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/'([^']*)'\s*:/g, '"$1":')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    return JSON.parse(fixed) as T;
  }
}
