# Model Configuration Governance

This document defines how Origin should manage AI model calls. The goal is to keep model, provider, endpoint, and reasoning changes centralized, auditable, and easy to swap without hunting through business routes.

## Core Rule

Do not hardcode variable model-call settings inside business code.

Variable settings include:

- `model`
- `provider`
- `baseUrl`
- `endpoint`
- `apiKey`
- `reasoningEffort`
- `timeout`
- `quality`
- `tier`

Business routes should usually choose a task role, for example:

```ts
{ modelRole: 'styleBible' }
```

The concrete model configuration should be resolved by `lib/model-routing.ts` from `.env.local` or the external env file.

`maxTokens` is handled differently from provider/model settings: business code may pass it as a task's desired output budget, but the unified LLM budget layer is the final authority. The budget layer clamps it against the resolved model's `contextWindow`, `maxOutputTokens`, estimated input tokens, reasoning reserve, and safety margin.

## Why

Origin needs to swap models, gateways, and quality/speed tiers frequently. If settings such as `reasoningEffort` are hardcoded in individual API routes, the project ends up with split configuration:

- some calls follow env/config;
- some calls silently ignore env/config;
- future model migrations become hard to audit;
- performance tuning becomes unreliable.

## Current Model Roles

| Role | Purpose | Default Config Source |
|---|---|---|
| `brain` | Creative reasoning, dialogue, script generation | `CLAUDE_*`, then `TEXT_*` |
| `structured` | Generic JSON repair, validation, extraction | `TEXT_*` |
| `styleBible` | Style bible extraction | `STYLE_BIBLE_*`, then `TEXT_*` |
| `projectClassifier` | Early project classification/evaluation, including default style selection and world-model checks | `PROJECT_CLASSIFIER_*`, then task fallback |
| `profileDerive` | Creator profile derivation | `PROFILE_DERIVE_*`, then `TEXT_*` |
| `visionExtract` | Reference-image visual extraction into structured character/scene asset fields | `VISION_EXTRACT_*`, then `TEXT_*` |
| `image` | Image generation/editing | `IMAGE_*` |
| `video` | Video generation | `VIDEO_*` |

## Env Naming Pattern

Task-specific workers should use a clear prefix and fall back to `TEXT_*` only when the task-specific variable is missing.

Example:

```env
STYLE_BIBLE_MODEL="gpt-5.5"
STYLE_BIBLE_REASONING_EFFORT="xhigh"

PROFILE_DERIVE_MODEL="gpt-5.5"
PROFILE_DERIVE_REASONING_EFFORT="xhigh"

VISION_EXTRACT_MODEL="gpt-5.5"
VISION_EXTRACT_REASONING_EFFORT="none"

PROJECT_CLASSIFIER_PROVIDER="volcengine_chat"
PROJECT_CLASSIFIER_API_BASE="https://ark.cn-beijing.volces.com/api/v3"
PROJECT_CLASSIFIER_API_ENDPOINT="/chat/completions"
PROJECT_CLASSIFIER_MODEL="doubao-seed-2-0-pro-260215"
PROJECT_CLASSIFIER_API_KEY="<ark api key>"
```

`STYLE_CLASSIFIER_*` remains a backwards-compatible alias for older local env files,
but new configuration should use `PROJECT_CLASSIFIER_*`.

The shared structured worker remains:

```env
TEXT_PROVIDER="openai_responses"
TEXT_API_BASE="https://api.openai.com/v1"
TEXT_API_ENDPOINT="/responses"
TEXT_MODEL="gpt-5.5"
TEXT_REASONING_EFFORT="xhigh"
TEXT_CONTEXT_WINDOW="400000"
TEXT_MAX_OUTPUT_TOKENS="32768"
```

`visionExtract` is intentionally separate from `structured`: it is for
reference-image recognition before custom character/scene field extraction. When
`VISION_EXTRACT_REASONING_EFFORT` is not configured, it defaults to `none` and
does not inherit `TEXT_REASONING_EFFORT`.

### Image Provider Primary/Fallback

Image generation is routed through `IMAGE_*`. The intended production setup is:

```env
# Primary image channel: Zerail OpenAI-compatible image API.
IMAGE_PROVIDER="zerail_images"
IMAGE_API_BASE="https://gateway.zerail.com/v1"
IMAGE_API_KEY="<zerail image key>"
IMAGE_MODEL="gpt-image-2"
IMAGE_GENERATIONS_ENDPOINT="/images/generations"
IMAGE_EDITS_ENDPOINT="/images/edits"

# Fallback image channel: Volcengine Seedream. This is used only after the
# primary channel fails IMAGE_FALLBACK_AFTER_FAILURES consecutive request attempts.
IMAGE_FALLBACK_ENABLED="true"
IMAGE_FALLBACK_AFTER_FAILURES="2"
IMAGE_FALLBACK_PROVIDER="volcengine_seedream"
IMAGE_FALLBACK_API_BASE="https://ark.cn-beijing.volces.com/api/v3"
IMAGE_FALLBACK_MODEL="doubao-seedream-4-5-251128"

# Either set an explicit fallback key, or keep the existing Seedream key.
# IMAGE_FALLBACK_API_KEY="<seedream key>"
IMAGE_SEEDREAM_API_KEY="<seedream key>"

# Existing Seedream tuning still applies to the fallback channel unless a
# matching IMAGE_FALLBACK_SEEDREAM_* override is provided.
IMAGE_SEEDREAM_SIZE="4K"
IMAGE_SEEDREAM_RESPONSE_FORMAT="b64_json"
IMAGE_SEEDREAM_WATERMARK="0"
IMAGE_SEEDREAM_SEQUENTIAL_IMAGE_GENERATION="disabled"
IMAGE_SEEDREAM_OPTIMIZE_PROMPT_MODE="standard"
```

Business code must continue to call `generateImage(...)`; it should not choose
between GPT-image and Seedream directly. Fallback selection belongs in
`lib/model-routing.ts` and `lib/image-gen.ts`, and provider failures are recorded
through the shared model-call observability path.

Emergency and tuning switches:

```env
# Set to 0 to bypass budget enforcement and return to legacy maxTokens behavior.
LLM_BUDGET_ENFORCE="1"

# Set to 1 to log budget decisions without enforcing clamps.
LLM_BUDGET_LOG_ONLY="0"

# Optional global fallback overrides.
LLM_CONTEXT_WINDOW="128000"
LLM_MAX_OUTPUT_TOKENS="8192"
LLM_REASONING_RESERVE_TOKENS="3000"

# Optional long JSON timeout override, in milliseconds.
LLM_JSON_REQUEST_TIMEOUT_MS="900000"

# Optional task-specific timeout override, generated from traceName.
SHOTS_GENERATE_REQUEST_TIMEOUT_MS="900000"

# Optional transient network retry for synchronous text LLM calls.
# Attempts includes the initial call; set to 1 to disable.
LLM_TEXT_NETWORK_RETRY_ATTEMPTS="2"
LLM_TEXT_NETWORK_RETRY_DELAY_MS="1000"
```

## Allowed Exceptions

Hardcoding is allowed only for:

- fallback defaults used when env/config is missing;
- UI placeholders and example labels;
- mock/test fixtures clearly marked as mock;
- temporary incident mitigation with a comment explaining the reason, scope, and removal plan.

## Configuration Boundary

Business routes may set task-intrinsic values:

- `maxTokens` as a desired output budget; it must still pass through the centralized budget clamp
- `responseFormat` / schema shape
- prompt builders
- `modelRole`
- 视频参考图预算 / `VIDEO_REFERENCE_IMAGE_BUDGET` 这类 video matcher 策略常量：当它描述的是业务侧参考图选择规则，而不是 provider/model 路由能力时，可以集中放在 matcher 相关代码里；必须保持单点定义，并在这里登记原因。
  - 2026-06-07：`VIDEO_REFERENCE_IMAGE_BUDGET` 从 7 调整为 9。原因：Seedance 合并片段需要同时提交首帧、场景、关键角色和道具参考图；这是业务侧参考图选择预算，不是 provider/model 路由能力。该常量仍保持在 `lib/video-reference-manifest.ts` 单点定义，并同步影响视频提示词阶段持久化 manifest 与视频提交阶段实际参考图上限。

Business routes must not hardcode global tuning knobs:

- `model`
- `reasoningEffort`
- provider/base URL/endpoint/API key

Those belong in env and `lib/model-routing.ts`.

## Disallowed Pattern

Avoid this in business API routes:

```ts
{ reasoningEffort: 'medium' }
```

Prefer:

```ts
{ modelRole: 'styleBible' }
```

and configure:

```env
STYLE_BIBLE_REASONING_EFFORT="high"
```

## Change Workflow

When changing any model call:

1. Check existing env variables and `lib/model-routing.ts`.
2. Reuse an existing role when possible.
3. Add a new role only when the task needs independent model or tuning control.
4. Keep business code focused on `modelRole`; avoid hardcoded model-call settings.
5. Expose the resolved runtime configuration in an admin/status endpoint when useful.
6. Run a hardcode scan.
7. Run type checks and at least one relevant endpoint test.

## Hardcode Scan

Use these checks after model-related changes:

```bash
rg -n "reasoningEffort:\s*['\"]|modelOverride:\s*['\"]|baseUrl:\s*['\"]https|apiKey:\s*['\"]" app lib
```

```bash
rg -n "model:\s*['\"]gpt" app lib
```

```bash
rg -n "gpt-|claude-|gemini-|seedance|gateway|api.openai|/responses|/messages" app lib public
```

Interpretation matters:

- fallback defaults and env routing in `lib/model-routing.ts` are acceptable;
- request assembly in `lib/llm.ts` is acceptable when it forwards resolved config instead of hardcoding a model or effort;
- UI placeholders are acceptable;
- business-route hardcoding of variable model-call settings is not acceptable.

## Verification Checklist

Before considering a model configuration change complete:

- `npx tsc --noEmit --pretty false` passes;
- runtime status shows the expected role, model, endpoint, and reasoning effort;
- the affected endpoint works or fails with a clear external provider error;
- no business route contains hardcoded variable model-call settings;
- the local app still returns `200` for `/workspace`.
