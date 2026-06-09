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
  recordModelCallEvent,
  type ResolvedModelConfig,
  type TextModelRole,
} from './model-routing';
import { fetchViaProxy, postJsonStreamRequest, postJsonWithProxySupport } from './proxy-fetch';
import { recordTokenUsageEvent, type TokenUsageContext } from './token-usage';
import { getExternalEnvValue } from './env';

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
  traceName?: string;
  traceAttempt?: number;
  traceMaxAttempts?: number;
  maxAttempts?: number;
  // 仅用于后台 Token 统计的旁路 metadata；不得影响 prompt / 参数 / 返回结构。
  tokenContext?: TokenUsageContext;
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

type TaskOutputPolicy = {
  baseMaxTokens: number;
  retryMaxTokens?: number;
  timeoutMs?: number;
  retryTimeoutMs?: number;
  allowOutputIncompleteRetry?: boolean;
};

const TASK_OUTPUT_POLICIES: Record<string, TaskOutputPolicy> = {
  'shots-generate': {
    baseMaxTokens: 28_000,
    retryMaxTokens: 32_768,
    timeoutMs: 900_000,
    retryTimeoutMs: 900_000,
    allowOutputIncompleteRetry: true,
  },
  'video-prompts': {
    baseMaxTokens: 8_000,
    retryMaxTokens: 12_000,
    timeoutMs: 600_000,
    retryTimeoutMs: 600_000,
    allowOutputIncompleteRetry: true,
  },
  assetsCharacters: {
    baseMaxTokens: 24_000,
    retryMaxTokens: 32_768,
    timeoutMs: 900_000,
    retryTimeoutMs: 900_000,
    allowOutputIncompleteRetry: true,
  },
  assetsScenes: {
    baseMaxTokens: 16_000,
    retryMaxTokens: 24_000,
    timeoutMs: 600_000,
    retryTimeoutMs: 600_000,
    allowOutputIncompleteRetry: true,
  },
  assetsProps: {
    baseMaxTokens: 12_000,
    retryMaxTokens: 20_000,
    timeoutMs: 420_000,
    retryTimeoutMs: 600_000,
    allowOutputIncompleteRetry: true,
  },
  styleBible: {
    baseMaxTokens: 16_000,
    retryMaxTokens: 24_000,
    timeoutMs: 600_000,
    retryTimeoutMs: 600_000,
    allowOutputIncompleteRetry: true,
  },
  'style-template-classifier': {
    baseMaxTokens: 800,
    retryMaxTokens: 1200,
    timeoutMs: 60_000,
    retryTimeoutMs: 90_000,
    allowOutputIncompleteRetry: true,
  },
  emotions: {
    baseMaxTokens: 8_000,
    retryMaxTokens: 12_000,
    timeoutMs: 420_000,
    retryTimeoutMs: 420_000,
    allowOutputIncompleteRetry: true,
  },
  'image-moderation-rewrite': {
    baseMaxTokens: 12_000,
    retryMaxTokens: 16_000,
    timeoutMs: 300_000,
    retryTimeoutMs: 300_000,
    allowOutputIncompleteRetry: true,
  },
  'image-moderation-rewrite-retry': {
    baseMaxTokens: 12_000,
    retryMaxTokens: 16_000,
    timeoutMs: 300_000,
    retryTimeoutMs: 300_000,
    allowOutputIncompleteRetry: true,
  },
  'retag.emotions': {
    baseMaxTokens: 8_000,
    retryMaxTokens: 12_000,
    timeoutMs: 420_000,
    retryTimeoutMs: 420_000,
    allowOutputIncompleteRetry: true,
  },
};

export async function chatComplete(
  user: UserRow | null,
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  opts = withDefaultTokenContext(user, opts);
  const cfg = resolveTextModelConfig(user, selectTextRole(opts));
  if (cfg.mode === 'fake') {
    return fakeReply(messages, opts);
  }
  const initialOpts = applyTaskRequestTimeout(opts);
  const budgetedOpts = applyTokenBudget(cfg, messages, initialOpts, 'complete');

  try {
    return await chatCompleteOnce(cfg, messages, budgetedOpts);
  } catch (e: any) {
    const fallbackCfg = selectTextFallbackConfig(cfg, e, opts);
    if (fallbackCfg) {
      console.warn(
        `[llm.fallback] ${opts.traceName || 'chatComplete'} ` +
        `${cfg.provider}/${cfg.model} -> ${fallbackCfg.provider}/${fallbackCfg.model}: ${String(e?.message || e).slice(0, 240)}`,
      );
      const fallbackOpts = applyTokenBudget(fallbackCfg, messages, initialOpts, 'complete');
      return chatCompleteOnce(fallbackCfg, messages, fallbackOpts);
    }

    const policy = resolveTaskOutputPolicy(opts.traceName);
    const decision = classifyJsonRetryError(e);
    const canRetryOutputIncomplete =
      opts.responseFormat !== 'json_object' &&
      !!policy?.allowOutputIncompleteRetry &&
      decision.reason === 'output_incomplete';
    if (!canRetryOutputIncomplete) throw e;

    const nextTraceAttempt = Math.max((opts.traceAttempt || 1) + 1, 2);
    const retryMaxTokens = resolveRetryMaxTokens(opts.traceName || '', budgetedOpts.maxTokens ?? opts.maxTokens ?? 4096);
    console.warn(
      `[${opts.traceName || 'chatComplete'}] retrying output_incomplete with maxTokens ` +
      `${budgetedOpts.maxTokens ?? opts.maxTokens ?? 4096} -> ${retryMaxTokens}`,
    );
    const retryOpts = applyTaskRequestTimeout({
      ...opts,
      maxTokens: retryMaxTokens,
      traceAttempt: nextTraceAttempt,
    });
    const retryBudgetedOpts = applyTokenBudget(cfg, messages, retryOpts, 'complete');
    return chatCompleteOnce(cfg, messages, retryBudgetedOpts);
  }
}

async function chatCompleteOnce(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions,
): Promise<string> {
  if (cfg.provider === 'zerail_messages' || cfg.provider === 'code80_messages' || cfg.provider === 'packy_messages') {
    return claudeMessagesComplete(cfg, messages, opts);
  }
  if (cfg.provider === 'zerail_responses' || cfg.provider === 'openai_responses' || cfg.provider === 'packy_responses') {
    return responsesComplete(cfg, messages, opts);
  }
  return openAIChatComplete(cfg, messages, opts);
}

function selectTextFallbackConfig(
  cfg: ResolvedModelConfig,
  error: any,
  opts: LLMOptions,
): ResolvedModelConfig | null {
  if (!cfg.fallbackConfigs?.length) return null;
  if (opts.modelOverride) return null;
  if (!isTextFallbackEligible(error)) return null;
  return cfg.fallbackConfigs[0] || null;
}

function isTextFallbackEligible(error: any): boolean {
  const parsed = classifyModelCallError(error);
  const statusCode = parsed.statusCode;
  if (statusCode === 429 || (statusCode != null && statusCode >= 500)) return true;
  if (statusCode != null && statusCode >= 400) return false;

  const message = String(error?.message || error || '').toLowerCase();
  if (error?.llmStatus === 'incomplete') return false;
  return [
    'timeout',
    '超时',
    'fetch failed',
    'network',
    'econnreset',
    'etimedout',
    'eai_again',
    'socket hang up',
    'retry_deadline_exceeded',
  ].some((needle) => message.includes(needle));
}

export async function observeTextModelCall<T>(
  cfg: ResolvedModelConfig,
  opts: LLMOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    recordModelCallEvent({
      cfg,
      slot: cfg.role || opts.modelRole || 'text',
      status: 'ok',
      latencyMs: Date.now() - started,
      traceName: opts.traceName,
      fallbackUsed: !!cfg.fallbackOf,
      meta: modelUsageMeta(result),
    });
    recordTokenUsageEvent({
      cfg,
      slot: cfg.role || opts.modelRole || 'text',
      modelRole: opts.modelRole || cfg.role || null,
      traceName: opts.traceName,
      status: 'ok',
      latencyMs: Date.now() - started,
      usage: modelUsageMeta(result),
      tokenContext: opts.tokenContext || null,
      meta: tokenAttemptMeta(cfg, opts),
    });
    return result;
  } catch (error: any) {
    const parsed = classifyModelCallError(error);
    recordModelCallEvent({
      cfg,
      slot: cfg.role || opts.modelRole || 'text',
      status: parsed.status,
      statusCode: parsed.statusCode,
      errorCode: parsed.errorCode,
      latencyMs: Date.now() - started,
      traceName: opts.traceName,
      fallbackUsed: !!cfg.fallbackOf,
      message: parsed.message,
      meta: modelUsageMeta(error?.usage),
    });
    recordTokenUsageEvent({
      cfg,
      slot: cfg.role || opts.modelRole || 'text',
      modelRole: opts.modelRole || cfg.role || null,
      traceName: opts.traceName,
      status: parsed.status,
      statusCode: parsed.statusCode,
      errorCode: parsed.errorCode,
      latencyMs: Date.now() - started,
      usage: modelUsageMeta(error?.usage),
      tokenContext: opts.tokenContext || null,
      meta: { ...tokenAttemptMeta(cfg, opts), message: parsed.message },
    });
    throw error;
  }
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

  const timeoutMs = opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS;
  const json: any = await observeTextModelCall(cfg, opts, () => postJsonWithTimeout(
    `${cfg.baseUrl}${cfg.endpoint || '/chat/completions'}`,
    cfg.apiKey,
    body,
    timeoutMs,
    `LLM 请求超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
  ));
  const choice = json?.choices?.[0];
  const finishReason = String(choice?.finish_reason || '');
  if (finishReason === 'length') {
    throw outputIncompleteError('length', opts, json?.usage || null, { finish_reason: finishReason });
  }
  const content = choice?.message?.content;
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
  const json = await observeTextModelCall(cfg, opts, () => postJsonWithTimeout(
    `${cfg.baseUrl}${cfg.endpoint || '/messages'}`,
    cfg.apiKey,
    body,
    opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS,
    `LLM 请求超时（>${Math.round((opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS) / 1000)}s 未返回）`,
  ));
  const stopReason = String(json?.stop_reason || json?.message?.stop_reason || '').toLowerCase();
  if (stopReason === 'max_tokens') {
    throw outputIncompleteError('max_tokens', opts, json?.usage || null, { stop_reason: stopReason });
  }
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
  const json = await observeTextModelCall(cfg, opts, () => postJsonWithTimeout(
    `${cfg.baseUrl}${cfg.endpoint || '/responses'}`,
    cfg.apiKey,
    body,
    opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS,
    `LLM 请求超时（>${Math.round((opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS) / 1000)}s 未返回）`,
  ));
  const status = String(json?.status || json?.response?.status || 'unknown');
  const usage = summarizeResponsesUsage(json);
  const incompleteDetails = getResponsesIncompleteDetails(json);
  const incompleteReason = getResponsesIncompleteReason(json);
  if (incompleteReason) {
    console.warn(
      `[llm.responses] incomplete ${formatResponsesTrace(cfg, opts)} ` +
      `status=${status} incomplete_details=${formatIncompleteDetails(incompleteDetails)} ` +
      `reason=${incompleteReason} usage=${formatUsageSummary(usage)}`,
    );
    throw outputIncompleteError(incompleteReason, opts, usage, incompleteDetails);
  }
  const content = extractResponsesText(json);
  if (!content) {
    const status = typeof json?.status === 'string' ? `，status=${json.status}` : '';
    throw new Error(`LLM 返回结构异常（缺 Responses output_text${status}）`);
  }
  console.info(
    `[llm.responses] complete ${formatResponsesTrace(cfg, opts)} ` +
    `status=${status} incomplete_details=none usage=${formatUsageSummary(usage)}`,
  );
  return stripThinkBlocks(content);
}

// 用 background 模式跑 Responses API: 适用于长耗时 / 高 reasoning 任务,
// 避免被中转站(gateway)的同步连接超时(常见 60-300s)掐断。
// 协议:
//   1) POST /responses { ..., background: true } → 立即返回 { id, status: 'queued'|'in_progress' }
//   2) GET  /responses/{id} 轮询 → status 进入 'completed'|'failed'|'cancelled'|'incomplete' 才结束
// 注意: background 模式要求服务端保存响应以便轮询, 因此和 cfg.disableResponseStorage 互斥, 这里
// 强制忽略 disableResponseStorage(只对本任务, 不修改 cfg)。
async function responsesBackgroundComplete(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions = {},
): Promise<string> {
  const submitBodyBase = buildResponsesBody(cfg, messages, opts, false);
  const submitBody: any = { ...submitBodyBase, background: true };
  delete submitBody.stream;
  // background 模式必须 store=true, 不能让外面的 disableResponseStorage 影响
  if ('store' in submitBody) delete submitBody.store;

  const clamp = (raw: number | undefined, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(max, raw && Number.isFinite(raw) ? raw : fallback));
  const submitTimeoutMs = clamp(positiveEnvInt('LLM_BACKGROUND_SUBMIT_TIMEOUT_MS'), 60_000, 5_000, 300_000);
  const totalTimeoutMs = opts.requestTimeoutMs || LLM_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = clamp(positiveEnvInt('LLM_BACKGROUND_POLL_INTERVAL_MS'), 5_000, 1_000, 30_000);
  const pollTimeoutMs = clamp(positiveEnvInt('LLM_BACKGROUND_POLL_TIMEOUT_MS'), 30_000, 5_000, 120_000);

  const submitJson = await observeTextModelCall(cfg, opts, () => postJsonWithProxySupport(
    `${cfg.baseUrl}${cfg.endpoint || '/responses'}`,
    cfg.apiKey,
    submitBody,
    submitTimeoutMs,
    `LLM background submit 超时（>${Math.round(submitTimeoutMs / 1000)}s 未确认入队）`,
  ));

  const responseId = String(submitJson?.id || '').trim();
  if (!responseId) {
    throw new Error('LLM background 提交未返回 response id');
  }

  console.info(
    `[llm.responses.bg] submitted ${formatResponsesTrace(cfg, opts)} ` +
      `id=${responseId} status=${String(submitJson?.status || 'unknown')}`,
  );

  const deadline = Date.now() + totalTimeoutMs;
  let finalJson: any = submitJson;
  let status = String(submitJson?.status || '').toLowerCase();
  let pollCount = 0;

  while (!['completed', 'failed', 'cancelled', 'incomplete'].includes(status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `LLM background 长时间未完成（>${Math.round(totalTimeoutMs / 1000)}s 未达终态）, response_id=${responseId}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pollCount += 1;
    try {
      finalJson = await getJsonWithProxySupport(
        `${cfg.baseUrl}${cfg.endpoint || '/responses'}/${responseId}`,
        cfg.apiKey,
        pollTimeoutMs,
        `LLM background poll #${pollCount} 超时`,
      );
    } catch (pollErr: any) {
      const msg = String(pollErr?.message || pollErr || '');
      const recoverable =
        msg.includes('超时') ||
        /LLM\s+(5\d\d|429)/i.test(msg) ||
        /timeout|abort|network|ECONNRESET|EAI_AGAIN/i.test(msg);
      if (!recoverable) throw pollErr;
      console.warn(
        `[llm.responses.bg] poll #${pollCount} transient error, will retry: ${msg.slice(0, 200)}`,
      );
      continue;
    }
    status = String(finalJson?.status || '').toLowerCase();
  }

  const usage = summarizeResponsesUsage(finalJson);
  const incompleteDetails = getResponsesIncompleteDetails(finalJson);

  if (status === 'failed' || status === 'cancelled') {
    const errMsg =
      finalJson?.error?.message ||
      finalJson?.error?.code ||
      JSON.stringify(finalJson?.error || finalJson?.incomplete_details || {}).slice(0, 400);
    console.warn(
      `[llm.responses.bg] ${status} ${formatResponsesTrace(cfg, opts)} ` +
        `id=${responseId} polls=${pollCount} err=${errMsg}`,
    );
    throw new Error(`LLM background ${status}: ${errMsg}`);
  }

  if (status === 'incomplete') {
    const incompleteReason = getResponsesIncompleteReason(finalJson) || 'incomplete';
    console.warn(
      `[llm.responses.bg] incomplete ${formatResponsesTrace(cfg, opts)} ` +
        `id=${responseId} polls=${pollCount} reason=${incompleteReason} ` +
        `incomplete_details=${formatIncompleteDetails(incompleteDetails)} ` +
        `usage=${formatUsageSummary(usage)}`,
    );
    throw outputIncompleteError(incompleteReason, opts, usage, incompleteDetails);
  }

  const content = extractResponsesText(finalJson);
  if (!content) {
    throw new Error(`LLM background 完成但缺 output_text, response_id=${responseId}`);
  }
  console.info(
    `[llm.responses.bg] complete ${formatResponsesTrace(cfg, opts)} ` +
      `id=${responseId} polls=${pollCount} status=${status} usage=${formatUsageSummary(usage)}`,
  );
  return stripThinkBlocks(content);
}

async function getJsonWithProxySupport(
  url: string,
  apiKey: string,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const err = new Error(timeoutMessage);
    err.name = 'AbortError';
    controller.abort(err);
  }, timeoutMs);
  let resp: Response;
  try {
    resp = await fetchViaProxy(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch (e: any) {
    if (controller.signal.aborted || e?.name === 'AbortError') throw new Error(timeoutMessage);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const friendly = text.slice(0, 500);
    throw new Error(`LLM ${resp.status}: ${friendly}`);
  }
  const json = await resp.json();
  if (json?.error) {
    const friendly =
      (typeof json.error === 'string' ? json.error : json.error?.message) ||
      JSON.stringify(json.error).slice(0, 400);
    throw new Error(`LLM 错误: ${friendly}`);
  }
  return json;
}

function summarizeResponsesUsage(json: any) {
  const usage = json?.usage || json?.response?.usage || {};
  const outputDetails = usage?.output_tokens_details || {};
  return {
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : null,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
    totalTokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : null,
    reasoningTokens: typeof outputDetails?.reasoning_tokens === 'number' ? outputDetails.reasoning_tokens : null,
  };
}

function modelUsageMeta(value: any): Record<string, unknown> {
  const usage = value?.usage || value?.response?.usage || value || {};
  const outputDetails = usage?.output_tokens_details || {};
  const inputTokens = firstNumber(usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  const outputTokens = firstNumber(usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const totalTokens = firstNumber(usage.totalTokens, usage.total_tokens);
  const reasoningTokens = firstNumber(usage.reasoningTokens, outputDetails.reasoning_tokens);
  const meta: Record<string, unknown> = {};
  if (inputTokens !== null) meta.inputTokens = inputTokens;
  if (outputTokens !== null) meta.outputTokens = outputTokens;
  if (totalTokens !== null) meta.totalTokens = totalTokens;
  if (reasoningTokens !== null) meta.reasoningTokens = reasoningTokens;
  return meta;
}

function firstNumber(...values: any[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function formatUsageSummary(usage: ReturnType<typeof summarizeResponsesUsage> | undefined): string {
  if (!usage) return 'n/a';
  return [
    `input=${usage.inputTokens ?? 'n/a'}`,
    `output=${usage.outputTokens ?? 'n/a'}`,
    `total=${usage.totalTokens ?? 'n/a'}`,
    `reasoning=${usage.reasoningTokens ?? 'n/a'}`,
  ].join(',');
}

function formatResponsesTrace(cfg: ResolvedModelConfig, opts: LLMOptions): string {
  const attempt = opts.traceAttempt
    ? ` attempt=${opts.traceAttempt}/${opts.traceMaxAttempts || '?'}`
    : '';
  return [
    `task=${opts.traceName || 'unknown'}`,
    attempt.trim(),
    `role=${cfg.role || opts.modelRole || 'unknown'}`,
    `provider=${cfg.provider}`,
    `model=${opts.modelOverride || cfg.model}`,
    `maxTokens=${opts.maxTokens ?? 4096}`,
  ].filter(Boolean).join(' ');
}

function outputIncompleteError(reason: string, opts: LLMOptions, usage?: any, details?: any): Error {
  const err: any = new Error(`LLM 输出不完整（reason=${reason}）：请提高 maxTokens 或降低 reasoningEffort`);
  err.llmStatus = 'incomplete';
  err.incompleteReason = reason;
  err.usage = usage;
  err.incompleteDetails = details;
  err.maxTokens = opts.maxTokens ?? 4096;
  return err;
}

function getResponsesIncompleteDetails(json: any): any {
  return json?.incomplete_details || json?.response?.incomplete_details || null;
}

function formatIncompleteDetails(details: any): string {
  if (!details) return 'none';
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
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

function classifyModelCallError(error: any) {
  const message = String(error?.message || error || '').slice(0, 500);
  const statusMatch = /\bLLM\s+(\d{3})\b/.exec(message);
  const statusCode = statusMatch ? Number(statusMatch[1]) : null;
  const lower = message.toLowerCase();
  if (statusCode === 429 || lower.includes('rate limit') || lower.includes('rate_limited') || lower.includes('too many requests')) {
    return { status: 'rate_limited', statusCode, errorCode: 'rate_limited', message };
  }
  if (lower.includes('timeout') || lower.includes('超时')) {
    return { status: 'failed', statusCode, errorCode: 'timeout', message };
  }
  if (statusCode && statusCode >= 500) {
    return { status: 'failed', statusCode, errorCode: `http_${statusCode}`, message };
  }
  if (statusCode && statusCode >= 400) {
    return { status: 'error', statusCode, errorCode: `http_${statusCode}`, message };
  }
  return { status: 'failed', statusCode, errorCode: error?.llmStatus || 'exception', message };
}

function selectTextRole(opts: LLMOptions): TextModelRole {
  if (opts.modelRole) return opts.modelRole;
  if (opts.responseFormat === 'json_object') return 'structured';
  return 'brain';
}

type TokenBudgetMode = 'complete' | 'stream';

type TokenBudgetDecision = {
  requestedMaxTokens: number;
  policyMaxTokens: number;
  effectiveMaxTokens: number;
  estimatedInputTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  reasoningReserve: number;
  safetyMargin: number;
  availableOutput: number;
  clamped: boolean;
  raisedByPolicy: boolean;
  taskPolicyName: string;
  bypassed: boolean;
  logOnly: boolean;
};

export function applyTokenBudget(
  cfg: ResolvedModelConfig,
  messages: ChatMessage[],
  opts: LLMOptions,
  mode: TokenBudgetMode,
): LLMOptions {
  const requestedMaxTokens = opts.maxTokens ?? 4096;
  const taskPolicy = resolveTaskOutputPolicy(opts.traceName);
  const policyMaxTokens = resolvePolicyMaxTokens(taskPolicy, opts.traceAttempt);
  const desiredMaxTokens = Math.max(requestedMaxTokens, policyMaxTokens);
  const estimatedInputTokens = estimateMessagesTokens(messages);
  const reasoningReserve = resolveReasoningReserve(cfg, opts);
  const safetyMargin = positiveEnvInt('LLM_BUDGET_SAFETY_MARGIN') || 512;
  const availableOutput = Math.floor(cfg.contextWindow - estimatedInputTokens - reasoningReserve - safetyMargin);
  const logOnly = envFlag('LLM_BUDGET_LOG_ONLY');
  const enforce = process.env.LLM_BUDGET_ENFORCE !== '0' && !logOnly;
  const bypassed = !enforce;

  let effectiveMaxTokens = requestedMaxTokens;
  let clamped = false;
  let raisedByPolicy = false;
  if (enforce) {
    if (availableOutput < 512) {
      logTokenBudget(cfg, opts, mode, {
        requestedMaxTokens,
        policyMaxTokens,
        effectiveMaxTokens: requestedMaxTokens,
        estimatedInputTokens,
        contextWindow: cfg.contextWindow,
        maxOutputTokens: cfg.maxOutputTokens,
        reasoningReserve,
        safetyMargin,
        availableOutput,
        clamped: false,
        raisedByPolicy: false,
        taskPolicyName: taskPolicy ? opts.traceName || 'unknown' : '',
        bypassed: false,
        logOnly: false,
      });
      throw new Error(
        `输入过长：估算 ${estimatedInputTokens} tokens，模型上下文 ${cfg.contextWindow}，` +
        `剩余输出预算 ${availableOutput} < 512，请缩短文本或分片处理`,
      );
    }
    effectiveMaxTokens = Math.min(desiredMaxTokens, cfg.maxOutputTokens, availableOutput);
    clamped = effectiveMaxTokens !== desiredMaxTokens;
    raisedByPolicy = effectiveMaxTokens > requestedMaxTokens;
  }

  logTokenBudget(cfg, opts, mode, {
    requestedMaxTokens,
    policyMaxTokens,
    effectiveMaxTokens,
    estimatedInputTokens,
    contextWindow: cfg.contextWindow,
    maxOutputTokens: cfg.maxOutputTokens,
    reasoningReserve,
    safetyMargin,
    availableOutput,
    clamped,
    raisedByPolicy,
    taskPolicyName: taskPolicy ? opts.traceName || 'unknown' : '',
    bypassed,
    logOnly,
  });

  if (!enforce) return opts;
  return { ...opts, maxTokens: effectiveMaxTokens };
}

function applyTaskRequestTimeout(opts: LLMOptions): LLMOptions {
  if (opts.requestTimeoutMs && opts.requestTimeoutMs > 0) return opts;
  const timeoutMs = resolvePolicyTimeoutMs(resolveTaskOutputPolicy(opts.traceName), opts.traceAttempt);
  if (!timeoutMs) return opts;
  return { ...opts, requestTimeoutMs: timeoutMs };
}

function resolveTaskOutputPolicy(taskName?: string): TaskOutputPolicy | null {
  const normalized = normalizeTaskName(taskName);
  if (!normalized) return null;
  return TASK_OUTPUT_POLICIES[normalized] || null;
}

function resolvePolicyMaxTokens(policy: TaskOutputPolicy | null, traceAttempt?: number): number {
  if (!policy) return 0;
  if ((traceAttempt || 1) > 1 && policy.retryMaxTokens) return policy.retryMaxTokens;
  return policy.baseMaxTokens;
}

function resolvePolicyTimeoutMs(policy: TaskOutputPolicy | null, traceAttempt?: number): number {
  if (!policy) return 0;
  if ((traceAttempt || 1) > 1 && policy.retryTimeoutMs) return policy.retryTimeoutMs;
  return policy.timeoutMs || 0;
}

function normalizeTaskName(taskName?: string): string {
  const value = String(taskName || '').trim();
  if (!value) return '';
  const aliases: Record<string, string> = {
    video_prompts: 'video-prompts',
    videoPrompt: 'video-prompts',
    videoPrompts: 'video-prompts',
    'shots.generate': 'shots-generate',
  };
  return aliases[value] || value;
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  const contentTokens = messages.reduce((sum, msg) => {
    return sum + estimateTextTokens(msg.role) + estimateTextTokens(msg.name || '') + estimateTextTokens(msg.content || '');
  }, 0);
  return Math.ceil(contentTokens + messages.length * 8 + 32);
}

function estimateTextTokens(text: string): number {
  const value = String(text || '');
  if (!value) return 0;
  const chinese = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonAscii = (value.match(/[^\x00-\x7f]/g) || []).length - chinese;
  const ascii = Math.max(0, value.length - chinese - nonAscii);
  return Math.ceil(chinese * 1.5 + Math.max(0, nonAscii) + ascii / 3);
}

function resolveReasoningReserve(cfg: ResolvedModelConfig, opts: LLMOptions): number {
  const override = reasoningReserveEnv(cfg.role || opts.modelRole);
  if (override) return override;

  const effort = String(opts.reasoningEffort === null ? 'none' : (opts.reasoningEffort || cfg.reasoningEffort || '')).toLowerCase();
  if (effort === 'xhigh' || effort === 'extra_high') return 12_000;
  if (effort === 'high') return 6_000;
  if (effort === 'medium') return 3_000;
  if (effort === 'low') return 1_500;
  if (effort === 'minimal' || effort === 'none' || effort === 'off') return 1_000;
  if (cfg.role === 'styleBible' || cfg.role === 'profileDerive') return 3_000;
  if (cfg.provider === 'zerail_responses' || cfg.provider === 'openai_responses' || cfg.provider === 'packy_responses') return 2_000;
  return 1_000;
}

function reasoningReserveEnv(role?: TextModelRole): number | undefined {
  const names: string[] = [];
  if (role === 'styleBible') names.push('STYLE_BIBLE_REASONING_RESERVE_TOKENS');
  else if (role === 'projectClassifier') names.push('PROJECT_CLASSIFIER_REASONING_RESERVE_TOKENS', 'STYLE_CLASSIFIER_REASONING_RESERVE_TOKENS');
  else if (role === 'styleClassifier') names.push('STYLE_CLASSIFIER_REASONING_RESERVE_TOKENS');
  else if (role === 'profileDerive') names.push('PROFILE_DERIVE_REASONING_RESERVE_TOKENS');
  else if (role === 'structured') names.push('STRUCTURED_REASONING_RESERVE_TOKENS');
  else if (role === 'brain') names.push('BRAIN_REASONING_RESERVE_TOKENS', 'CLAUDE_REASONING_RESERVE_TOKENS');
  names.push('TEXT_REASONING_RESERVE_TOKENS', 'LLM_REASONING_RESERVE_TOKENS');
  for (const name of Array.from(new Set(names))) {
    const value = positiveEnvInt(name);
    if (value) return value;
  }
  return undefined;
}

function logTokenBudget(
  cfg: ResolvedModelConfig,
  opts: LLMOptions,
  mode: TokenBudgetMode,
  budget: TokenBudgetDecision,
) {
  const fields = [
    `mode=${mode}`,
    `task=${opts.traceName || 'unknown'}`,
    `role=${cfg.role || opts.modelRole || 'unknown'}`,
    `provider=${cfg.provider}`,
    `model=${opts.modelOverride || cfg.model}`,
    `estimatedInput=${budget.estimatedInputTokens}`,
    `requestedMax=${budget.requestedMaxTokens}`,
    `policy=${budget.taskPolicyName || 'none'}`,
    `policyMax=${budget.policyMaxTokens}`,
    `effectiveMax=${budget.effectiveMaxTokens}`,
    `availableOutput=${budget.availableOutput}`,
    `contextWindow=${budget.contextWindow}`,
    `maxOutput=${budget.maxOutputTokens}`,
    `reasoningReserve=${budget.reasoningReserve}`,
    `safetyMargin=${budget.safetyMargin}`,
    `clamped=${budget.clamped}`,
    `raisedByPolicy=${budget.raisedByPolicy}`,
    `bypassed=${budget.bypassed}`,
    `logOnly=${budget.logOnly}`,
  ];
  const line = `[llm.budget] ${fields.join(' ')}`;
  if (budget.clamped || budget.availableOutput < 512) console.warn(line);
  else console.info(line);
}

function envFlag(name: string): boolean {
  const value = String(getExternalEnvValue(name) ?? process.env[name] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function positiveEnvInt(name: string): number | undefined {
  const n = Number(String(getExternalEnvValue(name) ?? process.env[name] ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

async function postJsonWithTimeout(
  url: string,
  apiKey: string,
  body: any,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<any> {
  return postJsonWithProxySupport(url, apiKey, body, timeoutMs, timeoutMessage);
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
  if (cfg.disableResponseStorage) body.store = false;
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
  // OpenAI Responses API 协议适配:
  //   - tool 角色不被 Responses API 接受, 折叠回 user;
  //   - system 在新版 Responses API (gpt-5.x 等) 上不会被算进
  //     "input messages must contain the word 'json'" 校验范围,
  //     必须改写成官方推荐的 'developer'。语义等价。
  //   - 其它角色 (user / assistant / developer) 原样透传。
  const out = messages
    .filter((msg) => String(msg.content || '').trim())
    .map((msg) => ({
      role: msg.role === 'tool'
        ? 'user'
        : msg.role === 'system'
          ? 'developer'
          : msg.role,
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

function getResponsesIncompleteReason(json: any): string {
  const status = String(json?.status || json?.response?.status || '').toLowerCase();
  if (status !== 'incomplete') return '';

  const details = getResponsesIncompleteDetails(json) || {};
  const reason = details?.reason
    || json?.incomplete_reason
    || json?.response?.incomplete_reason
    || 'unknown';
  return String(reason || 'unknown');
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
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts || 3));
  const role = opts.modelRole || 'structured';
  const cfg = resolveTextModelConfig(user, role);
  const model = opts.modelOverride || cfg.model;
  let lastErr: any = null;
  let currentMaxTokens = resolveTaskMaxTokens(taskName, opts.maxTokens, 1);
  let outputIncompleteRetried = false;
  for (let i = 0; i < maxAttempts; i++) {
    const attempt = i + 1;
    const t0 = Date.now();
    const reasoningEffort = opts.reasoningEffort === null
      ? 'off'
      : (opts.reasoningEffort || cfg.reasoningEffort || 'default');
    const requestTimeoutMs = resolveJsonRequestTimeoutMs(taskName, currentMaxTokens, reasoningEffort, opts.requestTimeoutMs, attempt);
    const taskMeta = `role=${role},provider=${cfg.provider},model=${model},maxTokens=${currentMaxTokens},reasoning=${reasoningEffort},timeoutMs=${requestTimeoutMs}`;
    try {
      const raw = await chatComplete(user, messages, {
        ...opts,
        maxTokens: currentMaxTokens,
        requestTimeoutMs,
        responseFormat: 'json_object',
        modelRole: opts.modelRole || 'structured',
        traceName: taskName,
        traceAttempt: attempt,
        traceMaxAttempts: maxAttempts,
      });
      const parsed = parser(raw);
      console.info(`[${taskName}] attempt ${attempt}/${maxAttempts} succeeded in ${Date.now() - t0}ms (${taskMeta})`);
      return parsed;
    } catch (e: any) {
      lastErr = e;
      const decision = classifyJsonRetryError(e);
      const elapsedMs = Date.now() - t0;
      console.warn(
        `[${taskName}] attempt ${attempt}/${maxAttempts} failed in ${elapsedMs}ms ` +
        `(reason=${decision.reason}, retryable=${decision.retryable}, ${taskMeta}, ` +
        `usage=${formatUsageSummary(e?.usage)}, incomplete_details=${formatIncompleteDetails(e?.incompleteDetails)}):`,
        e?.message,
      );
      if (!decision.retryable) throw e;
      if (i < maxAttempts - 1) {
        if (decision.reason === 'output_incomplete') {
          if (outputIncompleteRetried) throw e;
          outputIncompleteRetried = true;
          const nextMaxTokens = resolveRetryMaxTokens(taskName, currentMaxTokens);
          console.warn(
            `[${taskName}] retrying output_incomplete with maxTokens ${currentMaxTokens} -> ${nextMaxTokens}, ` +
            `reasoning=${reasoningEffort}`,
          );
          currentMaxTokens = nextMaxTokens;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        // 指数退避：1秒、2秒
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr || new Error(`${taskName} 调用失败（已重试 ${maxAttempts} 次）`);
}

/**
 * 走 Responses API background 模式跑 JSON 任务: 提交 → 轮询 → 拿结果。
 * 适用场景: 长耗时 / 高 reasoning 任务 (例如 shots-generate, 28k tokens + xhigh reasoning),
 * 避免被中转站的同步连接超时(60-300s 常见)掐断。
 *
 * 行为约束:
 *   - 只在 cfg.provider 是 Responses API 系 (zerail_responses / openai_responses / packy_responses)
 *     时走 background; 其它 provider 自动回退到 chatCompleteJsonWithRetry, 保证向后兼容。
 *   - 失败语义和 chatCompleteJsonWithRetry 对齐: 重试 output_incomplete, classifyJsonRetryError
 *     不可重试 (e.g. timeout / 4xx) 直接抛。
 *   - reasoningEffort / maxTokens / responseFormat 等行为复用同一套 LLMOptions。
 */
export async function chatCompleteJsonViaBackground<T = any>(
  user: UserRow | null,
  messages: ChatMessage[],
  opts: LLMOptions = {},
  parser: (raw: string) => T,
  taskName = 'json-task-bg',
): Promise<T> {
  const role = opts.modelRole || 'structured';
  const cfg = resolveTextModelConfig(user, role);

  // 非 Responses API provider (Claude / Chat Completions) 没有 background 模式 — 自动回退。
  const isResponsesProvider =
    cfg.provider === 'zerail_responses' ||
    cfg.provider === 'openai_responses' ||
    cfg.provider === 'packy_responses';
  if (!isResponsesProvider || cfg.mode === 'fake') {
    return chatCompleteJsonWithRetry(user, messages, opts, parser, taskName);
  }

  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts || 3));
  let currentMaxTokens = resolveTaskMaxTokens(taskName, opts.maxTokens, 1);
  let outputIncompleteRetried = false;
  let lastErr: any = null;

  for (let i = 0; i < maxAttempts; i++) {
    const attempt = i + 1;
    const t0 = Date.now();
    const reasoningEffort = opts.reasoningEffort === null
      ? 'off'
      : (opts.reasoningEffort || cfg.reasoningEffort || 'default');
    const requestTimeoutMs = resolveJsonRequestTimeoutMs(taskName, currentMaxTokens, reasoningEffort, opts.requestTimeoutMs, attempt);
    const taskMeta = `role=${role},provider=${cfg.provider},model=${cfg.model},maxTokens=${currentMaxTokens},reasoning=${reasoningEffort},timeoutMs=${requestTimeoutMs}`;

    try {
      const finalOpts: LLMOptions = {
        ...opts,
        maxTokens: currentMaxTokens,
        requestTimeoutMs,
        responseFormat: 'json_object',
        modelRole: opts.modelRole || 'structured',
        traceName: taskName,
        traceAttempt: attempt,
        traceMaxAttempts: maxAttempts,
      };
      const budgetedOpts = applyTokenBudget(cfg, messages, finalOpts, 'complete');
      const raw = await responsesBackgroundComplete(cfg, messages, budgetedOpts);
      const parsed = parser(raw);
      console.info(`[${taskName}] background attempt ${attempt}/${maxAttempts} ok in ${Date.now() - t0}ms (${taskMeta})`);
      return parsed;
    } catch (e: any) {
      lastErr = e;
      const decision = classifyJsonRetryError(e);
      const elapsedMs = Date.now() - t0;
      console.warn(
        `[${taskName}] background attempt ${attempt}/${maxAttempts} failed in ${elapsedMs}ms ` +
          `(reason=${decision.reason}, retryable=${decision.retryable}, ${taskMeta}, ` +
          `incomplete_details=${formatIncompleteDetails(e?.incompleteDetails)}):`,
        e?.message,
      );
      if (!decision.retryable) throw e;
      if (i < maxAttempts - 1) {
        if (decision.reason === 'output_incomplete') {
          if (outputIncompleteRetried) throw e;
          outputIncompleteRetried = true;
          const nextMaxTokens = resolveRetryMaxTokens(taskName, currentMaxTokens);
          console.warn(
            `[${taskName}] retrying background output_incomplete with maxTokens ${currentMaxTokens} -> ${nextMaxTokens}`,
          );
          currentMaxTokens = nextMaxTokens;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr || new Error(`${taskName} background 调用失败（已重试 ${maxAttempts} 次）`);
}

function resolveJsonRequestTimeoutMs(
  taskName: string,
  maxTokens: number,
  reasoningEffort: string,
  explicitTimeoutMs?: number,
  traceAttempt?: number,
): number {
  if (explicitTimeoutMs && explicitTimeoutMs > 0) return explicitTimeoutMs;

  const normalized = normalizeTaskName(taskName);
  const taskOverride = positiveEnvInt(`${normalized.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_REQUEST_TIMEOUT_MS`);
  if (taskOverride) return taskOverride;

  const envOverride = positiveEnvInt('LLM_JSON_REQUEST_TIMEOUT_MS');
  if (envOverride) return envOverride;

  const policy = resolveTaskOutputPolicy(normalized);
  const policyTimeoutMs = resolvePolicyTimeoutMs(policy, traceAttempt);
  if (policyTimeoutMs) return policyTimeoutMs;

  const effort = reasoningEffort.toLowerCase();
  let timeoutMs = LLM_REQUEST_TIMEOUT_MS;

  if (maxTokens >= 28_000) timeoutMs = 900_000;
  else if (maxTokens >= 20_000) timeoutMs = 600_000;
  else if (maxTokens >= 12_000) timeoutMs = 420_000;

  if (effort === 'xhigh' || effort === 'extra_high') timeoutMs = Math.max(timeoutMs, 900_000);
  else if (effort === 'high') timeoutMs = Math.max(timeoutMs, 600_000);

  return timeoutMs;
}

function resolveTaskMaxTokens(taskName: string, requestedMaxTokens: number | undefined, traceAttempt?: number): number {
  const policy = resolveTaskOutputPolicy(taskName);
  return Math.max(requestedMaxTokens ?? 4096, resolvePolicyMaxTokens(policy, traceAttempt));
}

function resolveRetryMaxTokens(taskName: string, currentMaxTokens: number): number {
  const policyRetryMaxTokens = resolvePolicyMaxTokens(resolveTaskOutputPolicy(taskName), 2);
  if (policyRetryMaxTokens) return Math.max(currentMaxTokens, policyRetryMaxTokens);
  return Math.ceil(currentMaxTokens * 2);
}

function classifyJsonRetryError(e: any): { retryable: boolean; reason: string } {
  const message = String(e?.message || e || '');
  const lower = message.toLowerCase();

  if (String(e?.llmStatus || '').toLowerCase() === 'incomplete') {
    const reason = String(e?.incompleteReason || '').toLowerCase();
    if (reason.includes('max_output_tokens') || reason.includes('max_tokens') || reason === 'length') {
      return { retryable: true, reason: 'output_incomplete' };
    }
    return { retryable: false, reason: `incomplete_${reason || 'unknown'}` };
  }

  if (lower.includes('context_length') || lower.includes('maximum context')) {
    return { retryable: false, reason: 'input_context' };
  }

  const httpStatus = message.match(/^LLM\s+(\d{3})/i)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return {
      retryable: status === 429 || status >= 500,
      reason: `http_${status}`,
    };
  }

  if (
    lower.includes('responses 输出不完整') ||
    lower.includes('status=incomplete') ||
    lower.includes('reason=max_output_tokens') ||
    lower.includes('max_output_tokens') ||
    lower.includes('stop_reason=max_tokens') ||
    lower.includes('reason=max_tokens')
  ) {
    return { retryable: true, reason: 'output_incomplete' };
  }
  if (message.includes('请求超时') || lower.includes('timeout') || lower.includes('abort')) {
    return { retryable: false, reason: 'timeout' };
  }

  if (
    message.includes('JSON') ||
    message.includes('Unexpected') ||
    lower.includes('parse') ||
    lower.includes('unterminated') ||
    lower.includes('invalid')
  ) {
    return { retryable: true, reason: 'json_parse' };
  }

  if (
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('socket') ||
    lower.includes('network')
  ) {
    return { retryable: true, reason: 'network' };
  }

  return { retryable: false, reason: 'non_retryable' };
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
  opts = withDefaultTokenContext(user, opts);
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
  const budgetedOpts = applyTokenBudget(cfg, messages, opts, 'stream');

  if (cfg.provider === 'zerail_messages' || cfg.provider === 'code80_messages' || cfg.provider === 'packy_messages') {
    return observeTextModelCall(cfg, budgetedOpts, () => claudeMessagesStream(cfg, messages, budgetedOpts, onChunk));
  }
  if (cfg.provider === 'zerail_responses' || cfg.provider === 'openai_responses' || cfg.provider === 'packy_responses') {
    return observeTextModelCall(cfg, budgetedOpts, () => responsesStream(cfg, messages, budgetedOpts, onChunk));
  }
  return observeTextModelCall(cfg, budgetedOpts, () => openAIChatStream(cfg, messages, budgetedOpts, onChunk));
}

function withDefaultTokenContext(user: UserRow | null, opts: LLMOptions): LLMOptions {
  if (!user?.id) return opts;
  const base: TokenUsageContext = {
    ownerId: user.id,
	    usernameSnapshot: user.phone || user.display_name || user.username || null,
  };
  return {
    ...opts,
    tokenContext: {
      ...base,
      ...(opts.tokenContext || {}),
    },
  };
}

function tokenAttemptMeta(cfg: ResolvedModelConfig, opts: LLMOptions): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    fallbackUsed: !!cfg.fallbackOf,
  };
  if (cfg.fallbackOf) meta.fallbackOf = cfg.fallbackOf;
  if (opts.traceAttempt != null) meta.traceAttempt = opts.traceAttempt;
  if (opts.traceMaxAttempts != null) meta.traceMaxAttempts = opts.traceMaxAttempts;
  return meta;
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
    resp = await postJsonStreamRequest(
      `${cfg.baseUrl}${cfg.endpoint || '/chat/completions'}`,
      cfg.apiKey,
      body,
      streamController.signal,
    );
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
    resp = await postJsonStreamRequest(url, apiKey, body, streamController.signal);
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
          if (evt?.type === 'response.incomplete' || evt?.response?.status === 'incomplete') {
            const details = evt?.response?.incomplete_details || evt?.incomplete_details || {};
            const rawReason = details?.reason ? String(details.reason) : '';
            const reason = rawReason ? `输出未完成：${rawReason}` : '输出未完成';
            // 流式 incomplete 错误同样挂上 llmStatus/incompleteReason，让上层（路由 / chatStream
            // 调用方）能像 chatComplete 那样按结构化字段判定要不要 retry-with-higher-budget，
            // 而不是只能 string-match 错误文案。
            const err: any = new Error(`LLM 流错误: ${reason}`);
            err.llmStatus = 'incomplete';
            err.incompleteReason = rawReason || 'unknown';
            err.incompleteDetails = details || null;
            err.usage = evt?.response?.usage || evt?.usage || null;
            throw err;
          }
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
