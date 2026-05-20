# VevDemo Bridge Audit - 2026-05-16

Scope: `/Users/mark/Documents/origin/vevdemo-1.0.6/fe/index.js`.

## Local Source Boundary

- The VevDemo source is currently available under `origin/vevdemo-1.0.6`.
- The directory is ignored locally by `.git/info/exclude` using `/vevdemo-1.0.6/`.
- This audit reads the bridge source only; it does not make VevDemo source part of the Origin repository.

## Confirmed Messages From VevDemo To Origin

| Message | Trigger | Payload |
| --- | --- | --- |
| `vevdemo:ready` | After `new window.VeVEditor(...)` succeeds and `notifyOriginReady()` runs | `ready`, `projectId`, `groupId`, `region`, `bridgeVersion`, `timestamp` |
| `vevdemo:status` | Origin ping/state acknowledgements and SDK export status side-channel | `status`, optional `payload` / `normalized`, bridge state |
| `vevdemo:materialsImported` | After browser-side material URL probe | `mode`, `count`, `mediaIds`, `results`, `cloudReachable` |
| `vevdemo:exportStatus` | Every SDK `VeVEditor.Events.System.ExportStatus` event | `status`, `taskId`, `outputUrl`, `message`, `code`, `raw`, bridge state |
| `vevdemo:exportComplete` | Only when normalized export status has an output URL and a complete-like status | `taskId`, `outputUrl`, `format: "mp4"`, `raw`, bridge state |
| `vevdemo:exportError` | When normalized export status looks failed/cancelled/error | `taskId`, `code`, `message`, `raw`, bridge state |

## Confirmed Messages From Origin To VevDemo

| Message | Behavior |
| --- | --- |
| `origin:ping` | Replies with `vevdemo:status`, `status: "pong"` |
| `origin:setProject` | Replies with `vevdemo:status`, `status: "origin-project-received"`, and does not switch the underlying VevDemo project yet |
| `origin:getState` | Replies with `vevdemo:status`, `status: "state"` |
| `origin:importMaterials` | Probes material URLs in the browser and replies with `vevdemo:materialsImported` |
| Other `origin:*` | Replies with `vevdemo:status`, `status: "message-received"` |

## UI Contract Implications

1. `vevdemo:exportStatus` and `vevdemo:exportComplete` can both be emitted for the same SDK export event.
   Origin UI must treat `exportStatus` as display-only and must call `/api/online-editor/export-complete` only from `exportComplete`. External webhook callers use `/api/volcengine/export-callback` with HMAC.

2. `origin:triggerExport` is not implemented as a real SDK export trigger in the current bridge. It falls into the generic acknowledgement path.
   Origin UI must not expose an automatic "re-export to VevDemo" action in P0.

3. `taskId` is normalized from SDK payload keys such as `taskId`, `TaskId`, `EditTaskId`, and may be absent if the SDK event does not include one.
   Origin UI should dedupe by `taskId || outputUrl`, and reject callback submission if both are missing.

4. The bridge target origin is derived from `document.referrer`; if absent or invalid it falls back to `*`.
   Origin still validates incoming message origin fail-closed, but the bridge target origin should be hardened in a later bridge patch.

5. SDK export callbacks are not wrapped in an outer try/catch beyond the event handler registration path.
   Origin UI should keep its own callback/retry/ack failure handling and should not assume every SDK failure becomes `vevdemo:exportError`.
