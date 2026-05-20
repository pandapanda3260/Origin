type VideoPromptTraceLevel = 'info' | 'warn' | 'error';

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
    });
  }
}

export function logVideoPromptTrace(
  event: string,
  payload: Record<string, unknown> = {},
  level: VideoPromptTraceLevel = 'info',
) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...payload,
  };
  const line = `[video_prompt_trace] ${safeJson(entry)}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export function summarizePromptForTrace(value: unknown, maxLength = 120) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
