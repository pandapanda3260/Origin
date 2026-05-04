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
import {
  resolveSlotModelConfig,
  resolveTextModelConfig,
  type ResolvedModelConfig,
  type TextModelRole,
} from './model-routing';

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
  modelRole?: TextModelRole;
  reasoningEffort?: string | null;
  requestTimeoutMs?: number;
  // 覆盖默认模型选择（默认用 settings 里的 text 模型）
  modelOverride?: string;
};

export type LLMResolved = ResolvedModelConfig;

const FAKE_NOTE = '[本地无 Key 假回复] 这条内容来自占位生成，请到设置页填入 OpenAI 兼容 API Key 后再试。';

/**
 * 读用户的 LLM 配置：优先 user_settings.models.text → 环境变量 → fake 兜底
 */
export function resolveLLMConfig(
  user: UserRow | null,
  slot: 'text' | 'image' | 'video' | 'storyboard' = 'text',
): LLMResolved {
  return resolveSlotModelConfig(user, slot);
}

/* ============================================================
   非流式调用：拿一个完整字符串
   ============================================================ */
// 单次 LLM 文本调用最长等 180 秒；之前 90s 对 gemini-3.x / claude-thinking
// 这种带"思考过程"的模型经常误伤（思考期间 0 字节流回，被 AbortController 砍掉），
// 给到 3 分钟兜底就够覆盖常见慢模型；如果中转站真挂了也不会无限等。
const LLM_REQUEST_TIMEOUT_MS = 180_000;

export async function chatComplete(
  user: UserRow | null,
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  const cfg = resolveTextModelConfig(user, selectTextRole(opts));
  if (cfg.mode === 'fake') {
    return fakeReply(messages, opts);
  }

  if (cfg.provider === 'zerail_messages') {
    return claudeMessagesComplete(cfg, messages, opts);
  }
  if (cfg.provider === 'zerail_responses') {
    return responsesComplete(cfg, messages, opts);
  }
  return openAIChatComplete(cfg, messages, opts);
}

async function openAIChatComplete(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
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

  const controller = new AbortController();
  const timeoutMs = opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}${cfg.endpoint || '/chat/completions'}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`LLM 请求超时（>${Math.round(timeoutMs / 1000)}s 未返回）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // 试着把中转站返回的 JSON 错误体里的 message 抽出来，体验更好
    const friendly = extractApiErrorMessage(text) || text.slice(0, 500);
    throw new Error(`LLM ${resp.status}: ${friendly}`);
  }
  const json: any = await resp.json();
  // 即使 200 也可能塞了一个 error 体（某些中转站这么干）
  if (json?.error) {
    const friendly = (typeof json.error === 'string' ? json.error : json.error?.message) || JSON.stringify(json.error).slice(0, 400);
    throw new Error(`LLM 错误: ${friendly}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM 返回结构异常（缺 message.content）');
  // 推理模型把 <think>...</think> 当 content 流出来，整段过滤后返回干净文本
  return stripThinkBlocks(content);
}

async function claudeMessagesComplete(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  const body = buildClaudeMessagesBody(cfg, messages, opts, false);
  const json = await postJsonWithTimeout(
    `${cfg.baseUrl}${cfg.endpoint || '/messages'}`,
    cfg.apiKey,
    body,
    opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS,
    `LLM 请求超时（>${Math.round((opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS) / 1000)}s 未返回）`,
  );
  const content = extractClaudeText(json);
  if (!content) throw new Error('LLM 返回结构异常（缺 Claude content text）');
  return stripThinkBlocks(content);
}

async function responsesComplete(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  const body = buildResponsesBody(cfg, messages, opts, false);
  const json = await postJsonWithTimeout(
    `${cfg.baseUrl}${cfg.endpoint || '/responses'}`,
    cfg.apiKey,
    body,
    opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS,
    `LLM 请求超时（>${Math.round((opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS) / 1000)}s 未返回）`,
  );
  const content = extractResponsesText(json);
  if (!content) throw new Error('LLM 返回结构异常（缺 Responses output_text）');
  return stripThinkBlocks(content);
}

/** 从中转站/OpenAI 风格的错误体中抽 message，方便上层显示友好提示 */
function extractApiErrorMessage(text: string): string {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    return j?.error?.message || j?.message || j?.detail || '';
  } catch {
    return '';
  }
}

function selectTextRole(opts: LLMOptions): TextModelRole {
  if (opts.modelRole) return opts.modelRole;
  if (opts.responseFormat === 'json_object') return 'structured';
  return 'brain';
}

async function postJsonWithTimeout(
  url: string,
  apiKey: string,
  body: any,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(timeoutMessage);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const friendly = extractApiErrorMessage(text) || text.slice(0, 500);
    throw new Error(`LLM ${resp.status}: ${friendly}`);
  }

  const json: any = await resp.json();
  if (json?.error) {
    const friendly = (typeof json.error === 'string' ? json.error : json.error?.message) || JSON.stringify(json.error).slice(0, 400);
    throw new Error(`LLM 错误: ${friendly}`);
  }
  return json;
}

function buildClaudeMessagesBody(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions,
  stream: boolean,
) {
  const converted = toClaudeMessages(messages);
  const body: any = {
    model: opts.modelOverride || cfg.model,
    messages: converted.messages,
    max_tokens: opts.maxTokens ?? 4096,
    stream,
  };
  if (converted.system) body.system = converted.system;
  if (opts.stop) body.stop_sequences = opts.stop;
  if (cfg.tier) body.tier = cfg.tier;
  return body;
}

function buildResponsesBody(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions,
  stream: boolean,
) {
  const body: any = {
    model: opts.modelOverride || cfg.model,
    input: toResponsesInput(messages),
    max_output_tokens: opts.maxTokens ?? 4096,
    stream,
  };
  if (opts.stop) body.stop = opts.stop;
  const reasoningEffort = opts.reasoningEffort === null
    ? ''
    : (opts.reasoningEffort || cfg.reasoningEffort || '');
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  if (opts.responseFormat === 'json_object') {
    body.text = { format: { type: 'json_object' } };
  }
  return body;
}

function toClaudeMessages(messages: ChatMessage[]) {
  const system: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const msg of messages) {
    const content = String(msg.content || '');
    if (!content) continue;
    if (msg.role === 'system') {
      system.push(content);
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const finalContent = msg.role === 'tool' ? `[tool]\n${content}` : content;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${finalContent}`;
    else out.push({ role, content: finalContent });
  }

  if (!out.length) out.push({ role: 'user', content: 'ping' });
  return { system: system.join('\n\n'), messages: out };
}

function toResponsesInput(messages: ChatMessage[]) {
  const out = messages
    .filter((msg) => String(msg.content || '').trim())
    .map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: msg.content,
    }));
  return out.length ? out : [{ role: 'user', content: 'ping' }];
}

function extractClaudeText(json: any): string {
  if (typeof json?.content === 'string') return json.content;
  if (Array.isArray(json?.content)) {
    return json.content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  const nested = json?.message?.content;
  if (Array.isArray(nested)) {
    return nested.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function extractResponsesText(json: any): string {
  if (typeof json?.output_text === 'string') return json.output_text;
  const chunks: string[] = [];
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (typeof item?.content === 'string') chunks.push(item.content);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part === 'string') chunks.push(part);
          else if (typeof part?.text === 'string') chunks.push(part.text);
          else if (typeof part?.output_text === 'string') chunks.push(part.output_text);
        }
      }
    }
  }
  if (chunks.length) return chunks.join('');
  const chatContent = json?.choices?.[0]?.message?.content;
  return typeof chatContent === 'string' ? chatContent : '';
}

/* ============================================================
   带重试的 JSON 调用
   适用场景：风格圣经 / 情绪标签 / 资产抽取等"必须返回有效 JSON"的任务
   - 失败原因可能是网络抖动、模型偶发非 JSON 回包、token 不够导致 JSON 截断
   - 我们最多重试 2 次（共调用 3 次）
   ============================================================ */
export async function chatCompleteJsonWithRetry<T = any>(
  user: UserRow | null,
  messages: ChatMessage[],
  opts: LLMOptions = {},
  parser: (raw: string) => T,
  taskName = 'json-task',
): Promise<T> {
  const maxAttempts = 3;
  let lastErr: any = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const raw = await chatComplete(user, messages, {
        ...opts,
        responseFormat: 'json_object',
        modelRole: opts.modelRole || 'structured',
      });
      return parser(raw);
    } catch (e: any) {
      lastErr = e;
      console.warn(`[${taskName}] attempt ${i + 1}/${maxAttempts} failed:`, e?.message);
      if (i < maxAttempts - 1) {
        // 指数退避：1秒、2秒
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr || new Error(`${taskName} 调用失败（已重试 ${maxAttempts} 次）`);
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
  const cfg = resolveTextModelConfig(user, selectTextRole(opts));
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

  if (cfg.provider === 'zerail_messages') {
    return claudeMessagesStream(cfg, messages, opts, onChunk);
  }
  if (cfg.provider === 'zerail_responses') {
    return responsesStream(cfg, messages, opts, onChunk);
  }
  return openAIChatStream(cfg, messages, opts, onChunk);
}

async function openAIChatStream(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions = {},
  onChunk: (text: string) => void,
): Promise<string> {
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

  // 流式调用整段 timeout 给 180s（流式天然更慢；超时主要兜底"中转站完全挂了不返回"）
  const streamController = new AbortController();
  const streamTimer = setTimeout(() => streamController.abort(), 180_000);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}${cfg.endpoint || '/chat/completions'}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: streamController.signal,
    });
  } catch (e: any) {
    clearTimeout(streamTimer);
    if (e?.name === 'AbortError') {
      throw new Error('LLM 流式请求超时（>180s 未返回）');
    }
    throw e;
  }
  if (!resp.ok || !resp.body) {
    clearTimeout(streamTimer);
    const text = await resp.text().catch(() => '');
    const friendly = extractApiErrorMessage(text) || text.slice(0, 500);
    throw new Error(`LLM ${resp.status}: ${friendly}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  // 推理模型（gpt-5.5 / o1 / claude thinking / gemini 3 thinking）会把
  // <think>...</think> / <thinking>...</thinking> 当成 content 流出来，
  // 用户看到的就是一大段英文乱码。这里做流式状态机，跨 chunk 兜住分裂的标签。
  const stripper = makeThinkStripper((clean) => {
    full += clean;
    if (clean) onChunk(clean);
  });

  try {
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
        if (payload === '[DONE]') {
          stripper.flush();
          return full;
        }
        try {
          const evt: any = JSON.parse(payload);
          // 中转站可能在流里塞 error 帧
          if (evt?.error) {
            const m = (typeof evt.error === 'string' ? evt.error : evt.error?.message) || JSON.stringify(evt.error).slice(0, 300);
            throw new Error(`LLM 流错误: ${m}`);
          }
          const delta = evt?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            stripper.feed(delta);
          }
        } catch (parseErr: any) {
          // 真正的 LLM 错误帧要抛出去；普通解析失败的心跳行忽略
          if (parseErr?.message?.startsWith('LLM 流错误')) throw parseErr;
        }
      }
    }
    stripper.flush();
    return full;
  } finally {
    clearTimeout(streamTimer);
    // 不论正常结束还是异常，都要释放 reader，避免 HTTP/2 / undici 连接不回池
    try { await reader.cancel(); } catch (_) {}
    try { reader.releaseLock(); } catch (_) {}
  }
}

async function claudeMessagesStream(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions = {},
  onChunk: (text: string) => void,
): Promise<string> {
  const body = buildClaudeMessagesBody(cfg, messages, opts, true);
  return streamJsonEvents(
    `${cfg.baseUrl}${cfg.endpoint || '/messages'}`,
    cfg.apiKey,
    body,
    (evt) => {
      if (evt?.type === 'content_block_delta' && typeof evt?.delta?.text === 'string') return evt.delta.text;
      if (typeof evt?.delta?.text === 'string') return evt.delta.text;
      if (typeof evt?.completion === 'string') return evt.completion;
      return '';
    },
    onChunk,
  );
}

async function responsesStream(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions = {},
  onChunk: (text: string) => void,
): Promise<string> {
  const body = buildResponsesBody(cfg, messages, opts, true);
  return streamJsonEvents(
    `${cfg.baseUrl}${cfg.endpoint || '/responses'}`,
    cfg.apiKey,
    body,
    (evt) => {
      if (evt?.type === 'response.output_text.delta' && typeof evt?.delta === 'string') return evt.delta;
      if (typeof evt?.delta === 'string') return evt.delta;
      if (typeof evt?.output_text === 'string') return evt.output_text;
      return '';
    },
    onChunk,
  );
}

async function streamJsonEvents(
  url: string,
  apiKey: string,
  body: any,
  extractDelta: (evt: any) => string,
  onChunk: (text: string) => void,
): Promise<string> {
  const streamController = new AbortController();
  const streamTimer = setTimeout(() => streamController.abort(), 180_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: streamController.signal,
    });
  } catch (e: any) {
    clearTimeout(streamTimer);
    if (e?.name === 'AbortError') {
      throw new Error('LLM 流式请求超时（>180s 未返回）');
    }
    throw e;
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(streamTimer);
    const text = await resp.text().catch(() => '');
    const friendly = extractApiErrorMessage(text) || text.slice(0, 500);
    throw new Error(`LLM ${resp.status}: ${friendly}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const stripper = makeThinkStripper((clean) => {
    full += clean;
    if (clean) onChunk(clean);
  });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        const payload = extractSseData(part);
        if (!payload) continue;
        if (payload === '[DONE]') {
          stripper.flush();
          return full;
        }
        try {
          const evt: any = JSON.parse(payload);
          if (evt?.error || evt?.type === 'error' || evt?.type === 'response.failed') {
            const err = evt?.error || evt?.response?.error || evt;
            const m = (typeof err === 'string' ? err : err?.message) || JSON.stringify(err).slice(0, 300);
            throw new Error(`LLM 流错误: ${m}`);
          }
          const delta = extractDelta(evt);
          if (delta) stripper.feed(delta);
        } catch (parseErr: any) {
          if (parseErr?.message?.startsWith('LLM 流错误')) throw parseErr;
        }
      }
    }
    stripper.flush();
    return full;
  } finally {
    clearTimeout(streamTimer);
    try { await reader.cancel(); } catch (_) {}
    try { reader.releaseLock(); } catch (_) {}
  }
}

function extractSseData(block: string): string {
  const lines = block.split(/\r?\n/);
  const data = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim();
  return data;
}

/**
 * 流式剥离 <think>...</think> / <thinking>...</thinking> 推理块。
 *
 * 工作原理：
 *   - 维护 inThink 状态，进入 think 块期间所有内容都丢弃
 *   - 处理跨 chunk 分裂的开/闭标签：保留尾部最多 12 字符在 buf 里
 *   - 不在 think 块内时，遇到看似"标签前缀"的尾部（如 chunk 以 "<thin" 结尾）
 *     先压住不发出，等下个 chunk 拼接后再判定
 */
function makeThinkStripper(emit: (clean: string) => void) {
  let buf = '';
  let inThink = false;
  const OPEN_RE = /<think(?:ing)?>/i;
  const CLOSE_RE = /<\/think(?:ing)?>/i;
  const PARTIAL_TAG_RE = /<\/?[a-zA-Z]{0,9}$/; // 12 字符内的"未闭合标签"

  function process() {
    while (buf.length > 0) {
      if (!inThink) {
        const m = buf.match(OPEN_RE);
        if (!m) {
          const tail = buf.match(PARTIAL_TAG_RE);
          const safeLen = tail ? buf.length - tail[0].length : buf.length;
          if (safeLen > 0) emit(buf.slice(0, safeLen));
          buf = buf.slice(safeLen);
          return;
        }
        const idx = m.index || 0;
        if (idx > 0) emit(buf.slice(0, idx));
        buf = buf.slice(idx + m[0].length);
        inThink = true;
      } else {
        const m = buf.match(CLOSE_RE);
        if (!m) {
          // 没看到结束标签：丢弃 buf，但保留最后 12 字符兜住分裂的 </thinking>
          if (buf.length > 12) buf = buf.slice(-12);
          return;
        }
        buf = buf.slice((m.index || 0) + m[0].length);
        inThink = false;
      }
    }
  }

  return {
    feed(chunk: string) {
      buf += chunk;
      process();
    },
    flush() {
      // 流结束：如果仍在 think 状态，剩下的内容丢弃；否则把残留 buf 全部 emit
      if (!inThink && buf.length > 0) emit(buf);
      buf = '';
    },
  };
}

/** 非流式调用专用：直接把整段文本里的 <think> 块剔除 */
export function stripThinkBlocks(text: string): string {
  if (!text) return text;
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
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
