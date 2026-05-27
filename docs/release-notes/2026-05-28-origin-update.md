# Origin update notes - 2026-05-28

Status: preflight only. Do not run production deployment until approved.

## Summary

- Adds video prompt draft editing, autosave, commit, restore, and apply-from-history APIs.
- Adds video prompt source hashing, backups, and snapshots so generated video tasks retain the exact prompt used at submit time.
- Updates storyboard, first-frame, tail-frame, and video prompt UI state handling around stale upstream artifacts and saved drafts.
- Adds `video_tasks.video_prompt_snapshot_json` as an additive SQLite column.
- Adds backfill scripts for existing project video prompt backups and existing video task prompt snapshots.

## Migration and Backfill

- Schema: `video_tasks.video_prompt_snapshot_json TEXT NOT NULL DEFAULT '{}'`.
- Startup migration: `lib/db.ts` adds the column if missing.
- Optional production backfills after backup:
  - `tsx scripts/backfill-video-prompt-lifecycle.ts`
  - `tsx scripts/backfill-video-prompt-snapshots.ts`

## Validation

- `npm run test:video-prompt-lifecycle` is part of `npm run verify:release:local`.
- Keep the normal release gate: `npm run verify:release:local`, production duplicate-index preflight, staging smoke, production smoke.

## Rollback

- Code rollback is the primary rollback path because the database change is additive.
- Restore SQLite only if the new code writes data that the previous code cannot tolerate or smoke tests show corruption.
