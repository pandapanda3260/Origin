# Mock Audit Tracker

This tracker records the first audit pass after enabling strict catch-all mode.
Runtime hits are written to `data/mock-audit.jsonl`.

## Labels

- A: implement backend
- B: explicit not implemented response
- C: remove or hide UI entry
- D: frontend cleanup for deprecated calls

## Confirmed Runtime Hits

| Label | Endpoint | Evidence | Decision |
| --- | --- | --- | --- |
| A | `POST /api/projects/:id/script-library` | `public/modules/script.js` adds generated/uploaded scripts; catch-all audit hit | Implemented true script library upsert. |
| A | `DELETE /api/projects/:id/script-library/:itemId` | `public/modules/script.js` delete action; catch-all audit hit | Implemented true delete. |
| A | `PATCH /api/projects/:id/script-library/:itemId` | `public/modules/script.js` rename action | Implemented true rename/update. |
| D | `POST /api/tasks/:id/status` | `public/modules/project.js` legacy fire-and-forget status calls; catch-all audit hit | Remove or reroute to current task DB model after task-center audit. |

## Static Findings

| Label | Endpoint | Evidence | Decision |
| --- | --- | --- | --- |
| A | `GET/POST/PUT /api/world-templates` | Route returns mock/empty data and frontend expects `templates` | Implemented true user-scoped CRUD. |
| A | `GET/DELETE /api/world-templates/:id` | Route always 404/ok without persistence | Implemented true lookup/delete. |
| A | `POST /api/orchestration/detect-obsolete` | Placeholder returns empty list; frontend exposes stale-asset cleanup | Implement minimal project diff or hide cleanup entry. |
| A | `POST /api/orchestration/compute-stale` | Placeholder returns empty list; frontend uses stale flags | Implement minimal stale calculation or keep feature disabled. |
| A | `POST /api/orchestration/sync-upstream` | Placeholder returns synced 0; frontend calls from asset propagation | Implement project-field sync or remove call. |
| B | `GET /api/batch` | Route returns empty list; no current frontend dependency found | Keep explicit placeholder if not productized. |
| B | `PUT/DELETE /api/asset/:id` | Route returns ok without mutation | Return explicit not implemented unless UI needs it. |

## Next Pass

Run the real browser flow with `MOCK_FALLBACK_MODE=audit` and append every new
hit from `data/mock-audit.jsonl` to this tracker before marking the mock audit
closed.
