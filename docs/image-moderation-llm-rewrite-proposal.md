# 图像审核拦截 · LLM 自动改写救回方案(方向 B,待审批)

状态:提案,待 Vasily 拍板后再动代码
日期:2026-06-04
触发:镜头10 首帧被 Azure 图像安全审核拦(`moderation_blocked`)且每次都失败。排查发现现有「自动救回」对图像审核**结构性空转**,本方案把它真正做起来。

---

## 1. 为什么要做(问题复述)

- 现有自动救回 `generateImageWithModerationRecovery`(`lib/safe-image-gen.ts`)被拦时调用**关键词改写** `rewriteImagePromptForModeration`,按「违规类别」套规则。
- 但图像服务**永远不返回类别**(只给笼统 `moderation_blocked` → 归 `unknown`)→ 命中 0 条规则 → 0 改动 → 放弃。审计实证:镜头10 三次失败均 `attempts=1 / rewriteDiff=0 / unknown`,从没真正发起「改写后重试」。
- LLM「首帧对话改写」(`app/api/frames/rewrite-draft`)已被硬关(`isFirstFrameRewriteEnabled() => false`),走手动编辑。
- 结论:要让被拦的首帧/尾帧能**自动**救回,只能引入一个 LLM 提示词中性化改写。

---

## 2. 设计

### 2.1 接入点(最小改动面)
仅改 `lib/safe-image-gen.ts` 的 catch(`info.blocked`)分支:保留关键词改写作为「快路径」;当**关键词改写产出 0 改动 或 类别为 unknown**时,改调新的 **LLM 改写** 产出软化后的提示词,再走原有重试循环。重试预算沿用现有 `attempt 0/1/2`(最多 2 次改写)。

### 2.2 LLM 调用(治理合规)
- 走 `lib/llm.ts`(`chat`/`chatStream`),**`modelRole: 'structured'`**(复用现有角色,不新增、不硬编码 model/provider/effort)。`traceName: 'image-moderation-rewrite'`,`maxTokens` ~800,`temperature` 低(~0.3)。
- 如需独立调参,仅新增**可选** env `IMAGE_SAFETY_REWRITE_*`,缺省回落 `TEXT_*`;默认本期**不新增 role**。
- 系统提示词目标:「在不改变视觉意图(场景/角色/构图/情绪)的前提下,改写这段图像提示词,去掉可能触发内容安全审核的描写,输出中性、具体、可拍的版本」。

### 2.3 只改自由文本、锁定段不动(保意图护栏)
- 只软化【主镜头】里的自由文本「画面」那段;**【角色锁定】【场景锁定】【道具锁定】【项目风格锁定】原样保留**,避免破坏一致性。
- 改写后:跑一次本地 `preflightImageModerationPrompt` + 长度检查;记录 `rewriteDiff` / `visualAnchorDescription`(audit 字段已支持,便于回看改了什么)。

### 2.4 成本与失败回落
- **限流**:复用 `checkAndRecordFirstFrameRewriteCall`(间隔 + 每日上限),被限流则跳过 LLM、直接回落提示。
- **回落到方向 A**:LLM 改写为空 / 调用异常 / 改写后仍被拦满次数 → 最终以**明确提示**收尾:`首帧未通过内容安全审核，提示词违规`(已和你确认的文案)。即:A 是地板,B 是上限。

### 2.5 范围
- 仅服务端「**审核自动救回**」;**不**重开用户侧「首帧对话改写」(`isFirstFrameRewriteEnabled` 保持 `false`)。
- 首帧 / 尾帧走同一 `generateImageWithModerationRecovery`,**两者都受益**。
- 参考图不参与改写(Q1 已判:参考图是 AI 生成、已过审,触发概率极低;改写只动文本)。

---

## 3. 影响面

- 主改:`lib/safe-image-gen.ts`(接入 LLM 改写分支)。
- 新增:一个 LLM 改写函数(放 `lib/content-sanitize.ts` 或新建 `lib/image-safety-rewrite.ts`)。
- 复用:`lib/llm.ts`、`first-frame-rewrite-rate-limit.ts`、现有 audit 持久化。
- 不动:`checkTailFramePreflight` / executor / 业务路由;不硬编码任何模型设置。
- env:如加 `IMAGE_SAFETY_REWRITE_*` 在治理文档登记;默认不加。

---

## 4. 治理合规(按 docs/model-config-governance.md)

- 业务侧只传 `modelRole: 'structured'`,model/provider/endpoint/effort 全由 `lib/model-routing.ts` + env 解析。
- 改完跑 hardcode scan(`rg` 三条)+ `npx tsc --noEmit`。
- 复用现有 role,不新增(除非你要独立调参)。

---

## 5. 测试

- 单测(mock LLM):被拦 → LLM 改写 → 重试成功(`moderationRecovered=true`);LLM 失败/空改写 → 回落明确提示;命中限流 → 跳过 LLM。
- 复跑现有 `scripts/test-frame-image-plan.js` 等相关测试 + `tsc`。
- 手测:对镜头10 触发一次,看是否自动救回或给出明确提示。

---

## 6. 待你拍板

1. **模型角色**:复用 `structured`(推荐,够用),还是新增 `imageSafetyRewrite` 独立调参?
2. **改写重试次数**:默认沿用 2 次(attempt 1/2),够不够?
3. **最终回落文案**:确认用「首帧未通过内容安全审核,提示词违规」作为救不回时的兜底提示?(建议是)
