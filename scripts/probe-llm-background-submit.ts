import { performance } from 'node:perf_hooks';
import { getDb, type UserRow } from '../lib/db';
import { buildResponsesBody, type ChatMessage, type LLMOptions } from '../lib/llm';
import { resolveTextModelConfig, type ResolvedModelConfig } from '../lib/model-routing';
import { postJsonWithProxySupport } from '../lib/proxy-fetch';

type ProbeCase = {
  label: string;
  messages: ChatMessage[];
  opts: LLMOptions;
  timeoutMs: number;
};

type Args = {
  run: boolean;
  userId: number | null;
  samples: number;
};

function parseArgs(): Args {
  const out: Args = { run: false, userId: null, samples: 5 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--run') out.run = true;
    else if (arg.startsWith('--user-id=')) out.userId = Number(arg.slice('--user-id='.length)) || null;
    else if (arg.startsWith('--samples=')) out.samples = Math.max(1, Math.min(10, Number(arg.slice('--samples='.length)) || 5));
  }
  return out;
}

function loadUser(userId: number | null): UserRow | null {
  if (!userId) return null;
  return getDb().prepare<{ id: number }, UserRow>('SELECT * FROM users WHERE id = @id').get({ id: userId }) || null;
}

function publicCfg(cfg: ResolvedModelConfig | null) {
  if (!cfg) return null;
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    endpoint: cfg.endpoint || '/responses',
    model: cfg.model,
    role: cfg.role || null,
    reasoningEffort: cfg.reasoningEffort || null,
    source: cfg.source,
    fallbackOf: cfg.fallbackOf || null,
    hasApiKey: !!cfg.apiKey,
  };
}

function makeSubmitBody(cfg: ResolvedModelConfig, messages: ChatMessage[], opts: LLMOptions) {
  const body: any = { ...buildResponsesBody(cfg, messages, opts, false), background: true };
  delete body.stream;
  if ('store' in body) delete body.store;
  return body;
}

function cases(): ProbeCase[] {
  const minimalMessages: ChatMessage[] = [
    { role: 'system', content: 'Return valid JSON only.' },
    { role: 'user', content: 'Return {"ok":true}.' },
  ];
  const productionMessages: ChatMessage[] = [
    { role: 'system', content: 'Return valid JSON only. You are validating background submit behavior.' },
    {
      role: 'user',
      content: [
        'Return a compact JSON object: {"ok":true,"items":[1,2,3]}.',
        'Do not produce long content. This probe intentionally uses production-like token and reasoning options to test submit behavior only.',
      ].join('\n'),
    },
  ];
  return [
    {
      label: 'minimal',
      messages: minimalMessages,
      opts: { maxTokens: 256, responseFormat: 'json_object', modelRole: 'structured', traceName: 'background-submit-probe.minimal' },
      timeoutMs: 10_000,
    },
    {
      label: 'production_like',
      messages: productionMessages,
      opts: { maxTokens: 28_000, responseFormat: 'json_object', modelRole: 'structured', traceName: 'background-submit-probe.production_like' },
      timeoutMs: 30_000,
    },
  ];
}

async function probeOne(cfg: ResolvedModelConfig, probeCase: ProbeCase, sampleNo: number, run: boolean) {
  const body = makeSubmitBody(cfg, probeCase.messages, probeCase.opts);
  const url = `${cfg.baseUrl}${cfg.endpoint || '/responses'}`;
  if (!run) {
    return {
      sample: sampleNo,
      skipped: true,
      bodyKeys: Object.keys(body).sort(),
      hasBackground: body.background === true,
      hasStream: Object.prototype.hasOwnProperty.call(body, 'stream'),
      hasStore: Object.prototype.hasOwnProperty.call(body, 'store'),
      maxOutputTokens: body.max_output_tokens ?? null,
      reasoning: body.reasoning || null,
    };
  }
  const started = performance.now();
  try {
    const json = await postJsonWithProxySupport(
      url,
      cfg.apiKey,
      body,
      probeCase.timeoutMs,
      `background submit probe ${probeCase.label} 超时（>${Math.round(probeCase.timeoutMs / 1000)}s 未确认入队）`,
    );
    return {
      sample: sampleNo,
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      responseId: String(json?.id || '').slice(0, 32),
      status: String(json?.status || 'unknown'),
    };
  } catch (error: any) {
    return {
      sample: sampleNo,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: String(error?.message || error).slice(0, 500),
    };
  }
}

async function main() {
  const args = parseArgs();
  const user = loadUser(args.userId);
  const primary = resolveTextModelConfig(user, 'structured');
  const fallback = primary.fallbackConfigs?.[0] || null;
  const configs = [
    { label: 'primary', cfg: primary },
    { label: 'fallback', cfg: fallback },
  ];

  const report: any = {
    mode: args.run ? 'live' : 'dry-run',
    userId: args.userId,
    samples: args.samples,
    providers: configs.map((item) => ({ label: item.label, config: publicCfg(item.cfg) })),
    results: [],
  };

  for (const { label, cfg } of configs) {
    if (!cfg) {
      report.results.push({ providerLabel: label, skipped: true, reason: 'missing_config' });
      continue;
    }
    const isResponsesProvider = ['zerail_responses', 'openai_responses', 'packy_responses'].includes(cfg.provider);
    if (!isResponsesProvider) {
      report.results.push({ providerLabel: label, skipped: true, reason: `provider_not_responses:${cfg.provider}` });
      continue;
    }
    for (const probeCase of cases()) {
      const samples = [];
      for (let i = 1; i <= args.samples; i += 1) {
        samples.push(await probeOne(cfg, probeCase, i, args.run));
      }
      report.results.push({ providerLabel: label, case: probeCase.label, timeoutMs: probeCase.timeoutMs, samples });
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
