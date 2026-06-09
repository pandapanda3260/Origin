import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { UserRow } from './db';
import { applyTokenBudget, observeTextModelCall } from './llm';
import { resolveTextModelConfig } from './model-routing';
import { postJsonWithProxySupport } from './proxy-fetch';
import { getExternalEnvValue } from './env';
import type { TokenUsageContext } from './token-usage';

export type TailFrameCaption = {
  status: 'ready';
  imageContentHash: string;
  text: string;
  generatedAt: string;
  model: string;
};

export function hashImageFileContent(imagePath: string): string {
  return createHash('sha256').update(readFileSync(imagePath)).digest('hex');
}

function imagePathToDataUrl(imagePath: string): string {
  const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
}

function extractResponsesText(json: any): string {
  if (typeof json?.output_text === 'string') return json.output_text.trim();
  const parts: string[] = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      const text = part?.text || part?.output_text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

function extractChatText(json: any): string {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part: any) => part?.text || '').filter(Boolean).join('\n').trim();
  }
  return '';
}

function cleanCaption(text: string): string {
  return String(text || '')
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

export async function captionTailFrameForVideo(
  user: UserRow | null,
  imagePath: string,
  tokenContext?: TokenUsageContext | null,
): Promise<TailFrameCaption> {
  const imageContentHash = hashImageFileContent(imagePath);
  const cfg = resolveTextModelConfig(user, 'frameConsistencyCheck');
  if (cfg.mode === 'fake') {
    return {
      status: 'ready',
      imageContentHash,
      text: '尾帧展示本片段结束时的构图、角色落点、动作结束状态、光照和空间关系。视频结尾需要自然抵达这个画面状态。',
      generatedAt: new Date().toISOString(),
      model: 'fake',
    };
  }

  const prompt =
    '请用中文描述这张视频尾帧参考图，只描述可见画面。' +
    '重点包括：最终构图、角色位置、动作结束状态、视线方向、主要道具、光照、空间关系。' +
    '不要编剧情，不要提到“图片/参考图/画面中有文字”，不要输出列表或 Markdown，120-220 字。';
  const dataUrl = imagePathToDataUrl(imagePath);
  const timeoutMs = Number(
    getExternalEnvValue('IMAGE_CAPTION_TIMEOUT_MS') ||
      getExternalEnvValue('ORIGIN_IMAGE_CAPTION_TIMEOUT_MS') ||
      process.env.IMAGE_CAPTION_TIMEOUT_MS ||
      process.env.ORIGIN_IMAGE_CAPTION_TIMEOUT_MS ||
      120_000,
  );
  const usageOpts = {
    maxTokens: 500,
    traceName: 'tail-frame-caption',
    modelRole: 'frameConsistencyCheck' as const,
    tokenContext: {
      ownerId: user?.id || null,
      usernameSnapshot: user?.phone || user?.display_name || user?.username || null,
      moduleKey: 'video',
      moduleLabel: '视频生成',
      featureKey: 'tail_frame_caption',
      featureLabel: '尾帧 Caption',
      operationKey: tokenContext?.operationKey || tokenContext?.callItemId || undefined,
      operationLabel: tokenContext?.operationLabel || '尾帧 Caption',
      ...(tokenContext || {}),
    },
  };
  const budgeted = applyTokenBudget(
    cfg,
    [{ role: 'user' as const, content: prompt }],
    usageOpts,
    'complete',
  );
  const maxOutputTokens = budgeted.maxTokens ?? 500;
  let text = '';

  if (cfg.provider === 'openai_responses' || cfg.provider === 'packy_responses' || cfg.provider === 'zerail_responses') {
    const body: any = {
      model: cfg.model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: dataUrl },
          ],
        },
      ],
      max_output_tokens: maxOutputTokens,
    };
    if (cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort };
    const json = await observeTextModelCall(
      cfg,
      budgeted,
      () => postJsonWithProxySupport(
        `${cfg.baseUrl}${cfg.endpoint || '/responses'}`,
        cfg.apiKey,
        body,
        timeoutMs,
        `尾帧 caption 生成超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
      ),
    );
    text = extractResponsesText(json);
  } else if (cfg.provider === 'openai_chat') {
    const json = await observeTextModelCall(
      cfg,
      budgeted,
      () => postJsonWithProxySupport(
        `${cfg.baseUrl}${cfg.endpoint || '/chat/completions'}`,
        cfg.apiKey,
        {
          model: cfg.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: maxOutputTokens,
          temperature: 0.2,
        },
        timeoutMs,
        `尾帧 caption 生成超时（>${Math.round(timeoutMs / 1000)}s 未返回）`,
      ),
    );
    text = extractChatText(json);
  } else {
    throw new Error(`当前文本 provider 不支持图片 caption：${cfg.provider}`);
  }

  const cleaned = cleanCaption(text);
  if (!cleaned) throw new Error('尾帧 caption 为空');
  return {
    status: 'ready',
    imageContentHash,
    text: cleaned,
    generatedAt: new Date().toISOString(),
    model: cfg.model,
  };
}
