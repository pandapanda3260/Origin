export type ScriptConsultReadyDetection = {
  markerReady: boolean;
  heuristicReady: boolean;
  ready: boolean;
  outline: string;
  matchedHeadings: string[];
};

export type ScriptConsultMessageLike = {
  role?: string;
  content?: string;
  readyToDraft?: boolean;
};

const OUTLINE_HEADINGS = ['场景', '人物', '核心冲突', '关键转折', '结尾画面'] as const;
const READY_MARKER_RE = /\[READY\]/i;
const STEP_TAG_RE = /<step>[^<]*<\/step>\s*/gi;
const EXPLICIT_CONFIRM_RE = /^(确认生成剧本|生成剧本|开始生成剧本|生成草稿|确认生成草稿|就这样生成剧本|就这样吧|没问题)$/;
const TRAILING_COMMAND_PUNCT_RE = /[。！!．.~～…]+$/;

function normalizeText(value: any): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(STEP_TAG_RE, '')
    .trim();
}

function stripReadyMarker(value: string): string {
  return value.replace(/\[READY\]\s*/gi, '').trim();
}

function isAssistantRole(role: any): boolean {
  return role === 'assistant' || role === 'ai';
}

function headingFromLine(line: string): string | null {
  const match = line.match(/^\s*(场景|人物|核心冲突|关键转折|结尾画面)\s*[：:]/);
  return match ? match[1] : null;
}

export function extractScriptConsultOutline(value: any): { outline: string; matchedHeadings: string[] } | null {
  const text = stripReadyMarker(normalizeText(value));
  if (!text) return null;

  const lines = text.split('\n');
  const headings = new Set<string>();
  let firstHeadingIndex = -1;

  lines.forEach((line, index) => {
    const heading = headingFromLine(line);
    if (!heading) return;
    if (firstHeadingIndex < 0) firstHeadingIndex = index;
    headings.add(heading);
  });

  if (headings.size < 3 || firstHeadingIndex < 0) return null;
  const outline = lines.slice(firstHeadingIndex).join('\n').trim();
  return {
    outline,
    matchedHeadings: OUTLINE_HEADINGS.filter((heading) => headings.has(heading)),
  };
}

export function detectScriptConsultReady(value: any): ScriptConsultReadyDetection {
  const raw = normalizeText(value);
  const markerReady = READY_MARKER_RE.test(raw);
  const outlineResult = extractScriptConsultOutline(raw);
  const markerOutline = markerReady
    ? stripReadyMarker(raw.slice(raw.search(READY_MARKER_RE)).replace(READY_MARKER_RE, '')).trim()
    : '';
  const outline = outlineResult?.outline || markerOutline;
  const heuristicReady = !!outlineResult;
  return {
    markerReady,
    heuristicReady,
    ready: markerReady || heuristicReady,
    outline,
    matchedHeadings: outlineResult?.matchedHeadings || [],
  };
}

export function findLatestScriptConsultOutline(messages: any[], fallbackOutline = ''): string {
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as ScriptConsultMessageLike;
      if (!message || !isAssistantRole(message.role)) continue;
      const detected = detectScriptConsultReady(message.content || '');
      if (detected.ready && detected.outline) return detected.outline;
    }
  }
  return normalizeText(fallbackOutline);
}

export function correctLatestScriptConsultReadyForRead(scriptConsult: any, scriptText: any): any {
  const sc = scriptConsult && typeof scriptConsult === 'object' ? scriptConsult : {};
  if (String(scriptText ?? '').trim()) return sc;

  const messages = Array.isArray(sc.messages) ? sc.messages : [];
  if (!messages.length) return sc;

  const lastIndex = messages.length - 1;
  const last = messages[lastIndex] as ScriptConsultMessageLike;
  if (!last || !isAssistantRole(last.role) || last.readyToDraft === true) return sc;

  const detected = detectScriptConsultReady(last.content || '');
  if (!detected.ready || !detected.outline) return sc;

  const nextMessages = messages.slice();
  nextMessages[lastIndex] = { ...last, readyToDraft: true };
  return {
    ...sc,
    messages: nextMessages,
    outline: detected.outline,
    ready: true,
  };
}

export function isExplicitScriptDraftConfirmCommand(value: any): boolean {
  const text = String(value ?? '').trim().replace(/\s+/g, '').replace(TRAILING_COMMAND_PUNCT_RE, '');
  return EXPLICIT_CONFIRM_RE.test(text);
}

export function shouldAutoTriggerConsultConfirm(userMessage: any, markerReady: boolean): boolean {
  return !!markerReady && isExplicitScriptDraftConfirmCommand(userMessage);
}
