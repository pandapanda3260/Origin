import type { ChatMessage } from './llm';

export const VIDEO_PROMPT_MAX_ATTEMPTS = 3;
export const VIDEO_PROMPT_FIRST_TEMPERATURE = 0.55;
export const VIDEO_PROMPT_RETRY_TEMPERATURE = 0.3;
export const VIDEO_PROMPT_RETRY_EXTRA_RULE =
  '⚠️ 上一次输出错了，必须严格按"运镜系统/角色/场景/0-Xs/.../基调/约束/音障"中文段落输出，**绝对不要写 shot 1: / [CAMERA] / camera: / characters: 这种英文键值对**。重写一遍。';

export function videoPromptTemperatureForAttempt(attempt: number) {
  return attempt === 1 ? VIDEO_PROMPT_FIRST_TEMPERATURE : VIDEO_PROMPT_RETRY_TEMPERATURE;
}

export function buildVideoPromptAttemptMessages(messages: ChatMessage[], attempt: number): ChatMessage[] {
  if (attempt <= 1 || messages.length === 0) return messages;
  return [
    ...messages.slice(0, -1),
    {
      ...messages[messages.length - 1],
      content: `${messages[messages.length - 1].content}\n\n${VIDEO_PROMPT_RETRY_EXTRA_RULE}`,
    },
  ];
}

export function buildVideoPromptRetryAudit(messages: ChatMessage[]) {
  return Array.from({ length: VIDEO_PROMPT_MAX_ATTEMPTS }, (_, idx) => {
    const attempt = idx + 1;
    return {
      attempt,
      temperature: videoPromptTemperatureForAttempt(attempt),
      messages: buildVideoPromptAttemptMessages(messages, attempt),
      appendedRule: attempt > 1 ? VIDEO_PROMPT_RETRY_EXTRA_RULE : '',
    };
  });
}
