import { createHash } from 'node:crypto';

export type ConsultTurnMessage = {
  role: 'user' | 'assistant';
  content: string;
  readyToDraft?: boolean;
};

export type ConsultTurnHistorySelection = {
  history: ConsultTurnMessage[];
  requestHistory: ConsultTurnMessage[];
  requestIncludedHistory: boolean;
  usedRequestHistory: boolean;
  source: 'db_existing_plus_current_turn' | 'request_history_plus_current_turn';
};

function cleanContent(value: any): string {
  return String(value ?? '').slice(0, 30000);
}

function cleanRole(value: any): 'user' | 'assistant' {
  return value === 'user' ? 'user' : 'assistant';
}

export function normalizeConsultTurnHistoryPayload(body: any): ConsultTurnMessage[] {
  const source = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.history)
      ? body.history
      : [];
  return source
    .filter((item: any) => item && typeof item === 'object')
    .map((item: any) => {
      const msg: ConsultTurnMessage = {
        role: cleanRole(item.role),
        content: cleanContent(item.content ?? item.message ?? item.text),
      };
      if (typeof item.readyToDraft !== 'undefined') msg.readyToDraft = !!item.readyToDraft;
      return msg;
    })
    .filter((item: ConsultTurnMessage) => item.content.trim());
}

export function selectConsultTurnHistory(
  dbMessages: any[],
  body: any,
  dbHistoryOnly: boolean,
): ConsultTurnHistorySelection {
  const dbHistory = Array.isArray(dbMessages)
    ? dbMessages
        .map((item: any) => ({
          role: cleanRole(item?.role),
          content: cleanContent(item?.content),
          readyToDraft: typeof item?.readyToDraft !== 'undefined' ? !!item.readyToDraft : undefined,
        }))
        .filter((item: ConsultTurnMessage) => item.content.trim())
    : [];
  const requestHistory = normalizeConsultTurnHistoryPayload(body);
  const requestIncludedHistory = Array.isArray(body?.messages) || Array.isArray(body?.history);
  const usedRequestHistory = !dbHistoryOnly && requestHistory.length > 0;
  return {
    history: usedRequestHistory ? requestHistory : dbHistory,
    requestHistory,
    requestIncludedHistory,
    usedRequestHistory,
    source: usedRequestHistory ? 'request_history_plus_current_turn' : 'db_existing_plus_current_turn',
  };
}

export function consultMessageHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
