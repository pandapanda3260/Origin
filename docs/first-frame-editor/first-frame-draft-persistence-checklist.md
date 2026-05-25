# First Frame Draft Persistence Checklist

Phase 0 checklist for persisting `storyboards[groupIdx].firstFrameEditDraft`.

## Draft Shape

```ts
{
  sourceHash: string | null;
  promptOverride?: string;
  referenceOverrides?: {
    excluded?: Array<{ role?: string; assetId?: string; assetName?: string; slot?: number; imageNo?: number }>;
    added?: Array<{ role: "character" | "scene" | "prop"; assetId: string }>;
  };
  negativePromptOverride?: string;
  updatedAt: string;
  updatedBy: number;
}
```

## Persistence Rules

- Store the draft on the storyboard slot, not under `frames.first`.
- Do not add `basePlanHash`; reuse the existing first-frame `sourceHash` concept.
- Do not add `frames.first.history`; current history remains `imageHistory`.
- `updatedBy` is written from the authenticated server user and ignored if present in a client request.
- `DELETE /api/frames/edit-draft` is idempotent.
- `PUT /api/frames/edit-draft` uses full replacement and last-write-wins.
- `styleRuleOverrides` is a legacy stored field only. It is never returned as canonical draft shape and is stripped on every new write.

## Rewrite Chat Status

- First-frame rewrite chat is temporarily disabled because AI-generated prompt patches can destructively replace the full generation prompt with a short edit summary.
- The editor UI must not render the rewrite chat panel, chat input, or AI apply controls while this feature is disabled.
- `POST /api/frames/rewrite-draft` returns `{ code: "feature_disabled" }` with HTTP 410 and must not call a text model while disabled.
- Manual editing remains supported for `promptOverride`, `negativePromptOverride`, and `referenceOverrides`.
- `styleRuleOverrides` remains a legacy stored field only. It is removed from the editor UI and stripped on every new write.
- Legacy `styleRuleOverrides` values are migrated into `promptOverride` on read and surfaced through a `legacy_style_rules_merged` notice so the old text remains visible before the user saves or discards the migrated draft.

## Normalization Notes

- `rowToPublic()` and `patchProjectForUser()` preserve unknown storyboard-slot fields by default.
- `buildFrameWorkflowNormalizationPatch()` rebuilds storyboards only when shot grouping normalization is needed; the draft must live on the slot so it travels with the slot when preserved.
- Any path that intentionally replaces a storyboard slot for first-frame generation should spread `prev` before writing, so `firstFrameEditDraft` survives successful generation.

## Validation Rules

- `referenceOverrides.add` entries must resolve to existing project assets.
- Effective image references after exclude/add must not exceed the image model multi-reference cap.
- `promptOverride` and `negativePromptOverride` must be bounded strings.
- Validation errors return `{ code: "validation_failed", errors: [{ field, message }] }`.

## Legacy Style Rule Migration

- Old drafts with non-empty `styleRuleOverrides` are normalized on read by `currentFirstFrameEditDraft()`.
- Each non-empty legacy rule is appended to `promptOverride` under the fixed `LEGACY_STYLE_RULE_BLOCK_PREFIX` block.
- If the old draft had no non-empty `promptOverride`, the prompt becomes only that legacy block; `applyFirstFrameDraftToPlan()` treats a prompt that `trimStart().startsWith(LEGACY_STYLE_RULE_BLOCK_PREFIX)` as append-only and keeps the current project prompt/style locks before it.
- If the old draft already had a non-empty `promptOverride`, the legacy block is appended to the end and the prompt remains a full override. This preserves the visible old rule text without freezing the current `plan.finalPrompt`.
- Empty or all-whitespace legacy rule arrays do not trigger migration, but the returned draft still strips the legacy key.
- `GET /api/frames/plan` returns `notices[{ code: "legacy_style_rules_merged" }]` for normal first-frame plans when a non-empty legacy rule block was merged. The banner remains visible until the user saves or discards the migrated draft.
