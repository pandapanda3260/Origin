export type ScriptConsultMessage = {
  role: string;
  content: string;
  readyToDraft?: boolean;
};

export type ScriptConsultState = {
  messages: ScriptConsultMessage[];
  outline: string;
  ready: boolean;
  startedAt: string | null;
  confirmedAt: string | null;
};

export const EMPTY_SCRIPT_CONSULT: ScriptConsultState = Object.freeze({
  messages: [],
  outline: '',
  ready: false,
  startedAt: null,
  confirmedAt: null,
});

function cleanString(value: any, max = 10000): string {
  return String(value ?? '').slice(0, max);
}

function cleanTimestamp(value: any): string | null {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 80) : null;
}

export function emptyScriptConsultState(): ScriptConsultState {
  return {
    messages: [],
    outline: '',
    ready: false,
    startedAt: null,
    confirmedAt: null,
  };
}

export function normalizeScriptConsultState(value: any): ScriptConsultState {
  const source = value && typeof value === 'object' ? value : {};
  const messages = Array.isArray(source.messages)
    ? source.messages
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any) => {
          const msg: ScriptConsultMessage = {
            role: cleanString(item.role, 40) || 'assistant',
            content: cleanString(item.content, 30000),
          };
          if (typeof item.readyToDraft !== 'undefined') msg.readyToDraft = !!item.readyToDraft;
          return msg;
        })
        .filter((item: ScriptConsultMessage) => item.content.trim())
    : [];
  return {
    messages,
    outline: cleanString(source.outline, 30000),
    ready: !!source.ready,
    startedAt: cleanTimestamp(source.startedAt),
    confirmedAt: cleanTimestamp(source.confirmedAt),
  };
}

export function isEmptyScriptConsultState(value: any): boolean {
  const state = normalizeScriptConsultState(value);
  return state.messages.length === 0
    && state.outline === ''
    && !state.ready
    && !state.startedAt
    && !state.confirmedAt;
}

