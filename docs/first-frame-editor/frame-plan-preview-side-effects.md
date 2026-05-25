# First Frame Plan Preview Side Effects

Phase 0 checklist for the first-frame edit console. The preview path must explain the current frame-generation plan without starting generation or polluting runtime metrics.

## Preview Must Not

- Call an image or text generation provider.
- Write `projects.data_json` or any project audit fields.
- Create, update, or claim `batches` / `batch_tasks`.
- Write knowledge-context audit rows.
- Charge credits or write billing ledger rows.
- Emit provider submission recovery records.
- Mark frame/video stale state.
- Change `imageHistory`, `frames.first`, `firstFrameUrl`, or video task state.

## Allowed Read-Only Work

- Read the project through `getProjectByIdForUser`.
- Compute current first-frame `sourceHash`.
- Resolve the current image model role through `resolveLLMConfig`.
- Build a dry-run `FrameImageGenerationPlan`.
- Resolve local image paths for reference-manifest preview.
- Run read-only batch preflight for `storyboard_images`.

## Isolation Plan

- Keep preview behind `GET /api/frames/plan`.
- Use a helper that only returns `{ plan, planSummary, modelSnapshot, sourceHash }`.
- Do not call `recordBatchKnowledgeAudit`, `createBatch`, `patchProjectForUser`, or `generateImageWithModerationRecovery`.
- If later caching is needed, cache only the preview response by `projectId + groupIdx + sourceHash` for a short TTL and never treat cache hits as generation attempts.

