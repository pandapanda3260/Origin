# VevDemo postMessage Bridge

Phase 3 confirmed that VevDemo 1.0.6 does not expose a built-in parent/child
postMessage protocol. Origin therefore uses a minimal local bridge in
`/Users/mark/Documents/origin/vevdemo-1.0.6/fe/index.js`.

## Current Scope

This bridge covers editor lifecycle, connectivity checks, browser-side Origin
material URL probing, and a guarded EditMaterial registration path for materials
that provide a Volcengine-supported source (`vid://`, `mid://`,
`directurl://`, or `tos://`). Origin now auto-registers completed `video_task` MP4s into
Volcengine VOD / VevDemo before sending them to the bridge, so the happy path is
real VevDemo material sync rather than a URL-only probe. Arbitrary Origin signed
HTTP URLs remain probe-only and cannot be dragged into the VevDemo timeline by
themselves.

## Messages From VevDemo To Origin

| Type | When | Data |
| --- | --- | --- |
| `vevdemo:ready` | After `new window.VeVEditor(...)` succeeds | `ready`, `projectId`, `groupId`, `region`, `bridgeVersion`, `timestamp` |
| `vevdemo:status` | Response to Origin messages or SDK status callbacks | `status`, optional request/context fields, `ready`, `projectId`, `groupId`, `region`, `bridgeVersion`, `timestamp` |
| `vevdemo:materialsImported` | After VevDemo probes Origin material URLs and optionally registers supported VevDemo sources | `mode: "browser-url-probe" | "create-edit-material"`, `count`, `registeredCount`, `probedCount`, `mediaIds`, `results`, `registrationResults`, `cloudReachable` |
| `vevdemo:exportSubmitted` | After `submitEditTaskAsync` returns from the VevDemo backend | `taskId` / `providerTaskId`, full `submitRequest`, full `submitResult`, bridge state |
| `vevdemo:exportStatus` | Normalized SDK export status event | `status`, `taskId`, `outputUrl`, `message`, `code`, `raw` |
| `vevdemo:exportComplete` | Normalized SDK export event when a completed status includes an output URL | `taskId`, `outputUrl`, `format: "mp4"`, `raw` |
| `vevdemo:exportError` | Normalized SDK export failure/cancel event | `taskId`, `code`, `message`, `raw` |

## Messages From Origin To VevDemo

| Type | Current Handling |
| --- | --- |
| `origin:ping` | VevDemo replies with `vevdemo:status` and `status: "pong"` |
| `origin:setProject` | When `vevProjectId` and `vevGroupId` are present, VevDemo destroys the current editor instance and recreates it against the bound VevDemo project. It first replies with `status: "switching-project"` when a switch is needed, then emits a fresh `vevdemo:ready` after the new editor loads. If the requested project is already active, it replies with `status: "origin-project-received"`. |
| `origin:getState` | VevDemo replies with `vevdemo:status` and `status: "state"` |
| `origin:importMaterials` | VevDemo probes each material URL with a hidden media element. If a material also carries `vevEditMid`, VevDemo reuses it. If it carries a supported `vevSource`, VevDemo calls `CreateEditMaterial`; otherwise it reports why registration was skipped. |
| Other `origin:*` | VevDemo acknowledges with `status: "message-received"` |

## Material Payload

Origin sends only materials that are marked browser-reachable. Materials with
`browserReachable: false` are skipped before `origin:importMaterials` is sent.

| Field | Meaning |
| --- | --- |
| `id` | Origin material or video task id |
| `url` | Browser-accessible Origin signed URL |
| `type` | `video`, `image`, `audio`, or upload kind |
| `title` | Display name |
| `durationSec` | Optional duration in seconds |
| `coverUrl` | Optional browser-accessible cover URL |
| `expiresAt` | Optional Unix timestamp in seconds. Signed Origin URLs must be re-synced after this time before playback/import can continue. |
| `browserReachable` | Whether VevDemo running in the browser can fetch/probe this URL |
| `cloudReachable` | Whether Volcengine cloud import can fetch this URL. Currently `false` for local Origin URLs. |
| `requiresOriginAuth` | Whether the URL requires Origin cookie/session auth |
| `vevSource` | Optional VevDemo `CreateEditMaterial` source. Must start with `vid://`, `mid://`, `directurl://`, or `tos://`. |
| `vevEditMid` | Existing VevDemo EditMaterial id. When present, the bridge treats the material as already registered and does not call `CreateEditMaterial` again. |
| `vevRegistrationReady` | Whether Origin believes this material is ready for VevDemo EditMaterial registration. |
| `vevRegistrationReason` | Machine-readable reason when registration is not ready. |
| `vevCreatePayload` | Optional fully formed `CreateEditMaterial` payload. If present, the bridge sends it as-is. |

## Material Sync Contract

The sync path is split between Origin and the local VevDemo bridge:

1. Origin `POST /api/volcengine/import` receives Origin material ids.
2. For completed `video_task` rows, Origin checks
   `data/vevdemo-material-bindings.json`.
3. Origin also ensures the current Origin project is bound to a VevDemo project
   via `data/vevdemo-project-bindings.json`. New bindings are created through
   Volcengine `CreateProject`, then passed to the iframe with `origin:setProject`.
4. If no material binding exists for the active VevDemo project and
   `autoRegister !== false`, Origin uploads the local MP4 to VOD, waits for H.264
   playback, creates or finds the VevDemo EditMaterial in that project, writes
   the binding, and returns `vevSource` / `vevEditMid`.
5. The bridge receives `origin:importMaterials` and either reuses `vevEditMid` or
   performs a guarded `CreateEditMaterial` fallback.
6. The bridge replies with `vevdemo:materialsImported`.

`origin:importMaterials` has two explicit result modes:

1. `mode: "create-edit-material"`: at least one material was registered or reused
   as a VevDemo EditMaterial. This is the only path expected to produce draggable
   timeline material.
2. `mode: "browser-url-probe"`: the Origin URL can be loaded by the browser, but
   it was not registered into VevDemo. This is only a diagnostic fallback.

Do not assume VevDemo can ingest arbitrary Origin URLs into Volcengine cloud
until both checks pass:

1. VevDemo browser-side fetch/playback can access the Origin material URL.
2. Volcengine cloud-side import can access the same URL, or the asset is first
   moved to a public/TOS/VOD-reachable location.

Material bindings are project-aware. New writes use
`resourceType:resourceId:vevProjectId` so the same Origin video can map to
different VevDemo `EditMid` values in different VevDemo projects. Legacy
`resourceType:resourceId` entries remain readable only when their embedded
`vevProjectId` is absent or matches the active target project.

Unsupported rows remain explicit:

- `uploads` backed by Origin cookie/session URLs are not auto-registered in P0.
- Materials without `vevSource`, `vevEditMid`, or `vevCreatePayload` are probe
  only.
- If H.264 playback is missing or the VOD play domain is not configured, Origin
  cannot complete auto-registration and the row is returned with
  `vevRegistrationReady: false`.

## Phase 5 Export Tracking Boundary

When `submitEditTaskAsync` succeeds, the iframe posts `vevdemo:exportSubmitted`
to the Origin parent. The parent records the Volcengine task id through
`/api/online-editor/vevdemo-export/submit`; this writes `vevdemo_export_tasks`,
not `exports`. Origin then polls
`/api/online-editor/vevdemo-export/status?projectId=...` until the worker has
converted the remote task into an `exports` row.

When Origin receives `vevdemo:exportComplete` with an `outputUrl`, it still uses
`/api/online-editor/export-complete` as a fast path. External webhooks must use
`/api/volcengine/export-callback` and pass HMAC headers. All URL-bearing paths
eventually write the same `exports.edl_json.vevDemo` shape. The
`exports.filename` column remains `null` until the remote MP4 has been
downloaded into `data/exports/<owner>/...`.

Current P0 fields in `edl_json.vevDemo`:

| Field | Meaning |
| --- | --- |
| `provider` | `vevdemo` |
| `remoteProvider` | `volcengine` |
| `taskId` | VevDemo / Volcengine export task id when available |
| `outputUrl` / `remoteUrl` | Remote MP4 URL returned by the editor/export event |
| `format` | Export format, currently `mp4` |
| `durationSec` | Optional duration in seconds |
| `receivedAt` | ISO timestamp when Origin accepted the callback |
| `localDownloadStatus` | `pending` until a later phase downloads the file locally |
