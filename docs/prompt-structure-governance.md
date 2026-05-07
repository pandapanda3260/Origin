# Prompt Structure Governance

This document defines the P0 prompt-structure upgrade workflow for Origin.
P0 does not start by rewriting prompts. It starts by making prompt changes
measurable, reversible, and safe to gray release.

## P0-0 Exit Criteria

P0-1 may start only after all of these are true:

- Every P0 module has at least 20 graded failure samples.
- The example module has at least 30 human-labeled samples.
- Other sampled P0 modules have at least 15 human-labeled samples.
- The eval script can report JSON success, field completeness, schema status,
  leakage, output character count, latency, retry count, and error type where
  available.
- At least one module has completed the loop: legacy baseline -> candidate
  prompt -> comparison report.
- Module-level prompt rollback works through configuration.
- Few-shot fixtures, leakage keyword fixtures, and this framework document exist.

## P0 Modules

P0-1: `scriptFullCreate`

- Framework: heavy creative.
- External output schema must stay unchanged.
- Five-part script structure and dialogue format stay compatible with current
  downstream modules.

P0-2: `styleBible`, `assetCharactersExtract`, `assetScenesExtract`,
`assetPropsExtract`

- Framework: light JSON extractor.
- Use exactly 3 fixed few-shot examples per JSON extraction module.
- Dynamic few-shot selection is out of scope for P0.

P0-3: `shotsGenerate`

- Framework: heavy creative/director planner.
- Focus on shot count, dialogue budget, character mapping, framing, and camera
  stability.

P0-4: `videoPromptGenerate`

- Framework: heavy prompt compiler.
- Output must not expose URLs, image numbers, reference image labels, or prompt
  framework scaffolding.

## Frameworks

Heavy framework for creative/compiler modules:

```text
# Role
# Goal
# Context
# Workflow
# Rules
# Output
# Self Check
# Failure Handling
```

Light framework for JSON/judge modules:

```text
# Role
# Goal
# Rules
# Output
```

`Self Check` is added to light modules only when the module has repeated hard
or soft failures.

Patch protocol modules may output:

```text
Natural response, when useful.
===PATCH===
{ "strict": "json" }
```

Pure patch output is allowed. If there is no patch, `===PATCH===` must not
appear.

Runtime guardrails are not converted to LangGPT prompts. They are versioned
rule cards:

```json
{
  "provider": "seedance",
  "providerVersion": "unknown",
  "ruleVersion": "v1",
  "appliesTo": "video-submit",
  "content": "..."
}
```

## Samples

Failure samples are stored outside the committed source tree by default:

```text
data/prompt-eval/samples/*.jsonl
```

Each sample should include:

- `caseId`
- `moduleId`
- `failureLevel`: `hard`, `soft`, or `preference`
- `failureTags`
- `inputSnapshot`
- `oldOutput`
- `humanFixSummary`
- `promptVersion`
- `schemaVersion`
- `modelConfigRef`
- `createdAt`

Failure levels:

- `hard`: parse failure, schema mismatch, missing key fields, blocked pipeline.
- `soft`: output parses but needs major repair.
- `preference`: output is usable but the user dislikes style/taste; excluded
  from default release gates.

Old outputs without `schemaVersion` are treated as `v0`.

`modelConfigRef` stores role/config identity, not secrets:

```json
{
  "modelRole": "structured",
  "configKey": "TEXT_*",
  "configVersionHash": "optional"
}
```

## Evaluation

Run:

```bash
npm run prompt-eval:report -- --samples data/prompt-eval/samples
```

Use the synthetic fixture for smoke checks:

```bash
npm run prompt-eval:report -- --samples fixtures/prompt-eval/sample.example.jsonl
```

Compare legacy and candidate reports:

```bash
npm run prompt-eval:report -- --baseline legacy-report.json --candidate candidate-report.json
```

Comparison summary shape:

```json
{
  "comparableCases": 0,
  "orphanCandidates": 0,
  "orphanCandidateCaseIds": [],
  "comparison": {
    "comparableCases": 0,
    "winRate": 0,
    "lossRate": 0,
    "tieRate": 0,
    "hardFailureDelta": 0,
    "leakDelta": 0,
    "outputCharDelta": 0,
    "outputCharP95Delta": 0,
    "latencyDelta": 0,
    "latencyP95Delta": 0
  },
  "byModule": {
    "styleBible": {
      "comparableCases": 0,
      "winRate": 0,
      "lossRate": 0,
      "tieRate": 0,
      "hardFailureDelta": 0,
      "leakDelta": 0,
      "outputCharDelta": 0,
      "outputCharP95Delta": 0,
      "latencyDelta": 0,
      "latencyP95Delta": 0
    }
  }
}
```

`comparison` is global. `byModule` repeats the same metrics per module, so a
single improved module cannot hide another module regressing. Candidate-only
cases are reported as `orphanCandidates` and `orphanCandidateCaseIds`; they are
not counted as comparable cases.

In P0-0, `schemaOk` is a sample/report field, not automatic schema validation.
P0-2 should add zod or JSON Schema validation for JSON extractor modules before
claiming automatic schema compliance.

Quality scoring and verdict threshold:

- `jsonOk: true` adds 2; `jsonOk: false` subtracts 4.
- `schemaOk: true` adds 2; `schemaOk: false` subtracts 4.
- `requiredFieldCompleteness` adds up to 2 points.
- High-risk leakage subtracts 5; low-risk leakage subtracts 1.
- `humanRating.canProceed: true` adds 4; `false` subtracts 4.
- `humanRating.editAmount` subtracts 0.5 for `minor`, 2 for `major`, and 3 for
  `rewrite`.
- Candidate score minus baseline score `>= 1` is a win, `<= -1` is a loss, and
  anything between is a tie.

Release gate for each P0 candidate:

- New output clearly better than legacy in at least 50% of comparable cases.
- New output clearly worse than legacy in at most 10% of comparable cases.
- Human-labeled "can proceed" rate is at least 70% and not below legacy.
- Hard failure rate must not rise.
- If legacy hard failure rate is at least 5%, candidate hard failure rate must
  decline.
- Average output character count growth is at most 15%; P95 growth is at most
  25%.
- Average latency growth is at most 20%; P95 growth is at most 30%.
- JSON/schema modules must not reduce parse success or schema compliance.
- High-risk leakage must not increase.
- Module-specific gates must be checked against `byModule`, not only the global
  `comparison` block.
- `orphanCandidates` must be 0 for release-gate runs unless the new sample set
  has been intentionally expanded and the baseline has been regenerated.

## Leakage Detection

Leakage fixtures live in:

```text
fixtures/prompt-eval/leak-keywords.json
```

Rules:

- JSON and plain-description outputs get strict leakage scans.
- Script outputs scan only outside the story body to avoid false positives in
  character dialogue.
- `videoPromptGenerate` additionally blocks URLs, image labels, `Image N`,
  `reference image N`, `ref N`, `image_n`, and Chinese reference-image variants.
- `allowlist` entries are exact keyword matches; substring allowlisting is not
  allowed because it can silently disable whole high-risk keyword families.

## Rollout

Each module starts with `legacy`.

Prompt version resolution is implemented in `lib/prompt-governance.ts`.
Configuration may use per-module environment variables:

```env
PROMPT_VERSION_SCRIPT_FULL_CREATE="legacy"
PROMPT_VERSION_SCRIPT_FULL_CREATE_USERS="1=v1,2=v1"
PROMPT_VERSION_SCRIPT_FULL_CREATE_PROJECTS="project_a=v1"
```

Or JSON config:

```env
PROMPT_VERSION_CONFIG_JSON='{"modules":{"scriptFullCreate":{"defaultVersion":"legacy","users":{"1":"v1"},"projects":{"project_a":"v1"}}}}'
```

Precedence:

```text
project override > user override > module default
```

The dry-run endpoint `/api/debug/prompt-version` is for internal verification.
In production it returns 404 unless `PROMPT_DEBUG_TOKEN` is configured and the
request sends the same value in `x-debug-token`.

If a configured version is unknown, the resolver falls back to the module's
default version and returns a warning.

Rollout sequence:

1. Candidate passes offline gate.
2. Candidate is enabled for allowlisted users/projects for at least 3 days.
3. Monitor hard failures, leakage, output character count, latency, and human rework
   signals.
4. If healthy, make the candidate the module default.
5. If unhealthy, switch the module back to `legacy`.
