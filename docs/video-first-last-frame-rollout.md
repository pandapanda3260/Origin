# 首尾帧视频链路上线说明

## 默认策略

- `ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE=1` 时，`auto` 模式会在片段已有可用首帧、尾帧意图已确认、尾帧状态为 `ready`、当前视频模型 capability 支持首尾帧时，提交 `first_last_frame`。
- `ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE=0` 是 hard off。请求级 `submitMode=first_last_frame` 和环境级 `VIDEO_SUBMIT_MODE=first_last_frame` 都不能绕过。
- `submitMode=reference_images` 是调试模式。若片段存在尾帧信号，系统复用 `target_end_not_used` warning，并设置 `reason=reference_images_mode`；前端只展示文本，不提供 next action。
- 首帧变化会让本片段尾帧标记为 `stale`，并清理对应 `videoTasks[groupIdx]`。PUT 保存路径以服务端返回的项目状态为准，前端保存后必须用 response 覆盖本地缓存。

## 回滚

最快回滚方式：

```bash
ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE=0
```

修改后重启服务。该配置是 hard off，不会被请求级 `submitMode` 绕过。已经提交给 provider 的 in-flight 任务不会被撤回，因为 payload mode 在提交时已经固化。

如果出现配置矛盾，例如 `VIDEO_SUBMIT_MODE=first_last_frame` 但 hard off 为 `0`，运行时会输出：

```text
[video-config] VIDEO_SUBMIT_MODE='first_last_frame' ignored because ORIGIN_FIRST_LAST_FRAME_VIDEO_MODE=0
```

## 新增视频模型流程

1. 在 [model-routing.ts](/Users/mark/Documents/origin/lib/model-routing.ts) 的 `listKnownVideoModelIds()` 静态清单中登记模型 id。该清单不读取运行时 env，代表产品可能路由到的视频模型全集。
2. 在 [video-provider-capabilities.ts](/Users/mark/Documents/origin/lib/video-provider-capabilities.ts) 增加 capability entry。未验证前使用 `firstLastFrameMode: 'unsupported'`。
3. 执行 `npm run check:video-capabilities`，确认清单和 capability 表覆盖一致。`verifiedAt` 超过 180 天会产生 warn，需要安排复检。
4. 若模型属于 Seedance 首尾帧候选，执行：

```bash
npm run probe:seedance-first-last -- --run --models <model-id>
```

probe 会提交最小 5s、720p、1:1 的真实任务并请求 `return_last_frame:true`。返回码含义：

- `0`：全部 runtime verified。
- `1`：至少一个模型被确认 unsupported。
- `2`：仅存在网络、鉴权、余额、临时 5xx 等 operator retry 问题，capability 表不要改，重试即可。

5. probe 通过后，手动更新 [video-provider-capabilities.ts](/Users/mark/Documents/origin/lib/video-provider-capabilities.ts) 中对应模型的 `verifiedBy: 'runtime_verified'` 和 `verifiedAt`。

## 验收口径

- `videoPlan.payloadMode`、`videoAudit.payloadMode`、批次日志和 UI 提示必须表达同一个实际模式。
- 显式 `first_last_frame` 遇到 unsupported capability 时硬失败，文案说明模型不支持，而不是误报尾帧不可用。
- `auto` 模式遇到尾帧缺失、失败、stale、file_missing 时软降级；遇到 `pending` 时阻止提交并提示等待。
