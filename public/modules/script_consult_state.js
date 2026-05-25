export const EMPTY_SCRIPT_CONSULT = Object.freeze({
  messages: [],
  outline: "",
  ready: false,
  startedAt: null,
  confirmedAt: null,
});

function cleanString(value, max) {
  max = max || 10000;
  return String(value == null ? "" : value).slice(0, max);
}

function cleanTimestamp(value) {
  var text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, 80) : null;
}

export function emptyScriptConsultState() {
  return {
    messages: [],
    outline: "",
    ready: false,
    startedAt: null,
    confirmedAt: null,
  };
}

export function normalizeScriptConsultState(value) {
  var source = value && typeof value === "object" ? value : {};
  var messages = Array.isArray(source.messages)
    ? source.messages
        .filter(function (item) { return item && typeof item === "object"; })
        .map(function (item) {
          var msg = {
            role: cleanString(item.role, 40) || "assistant",
            content: cleanString(item.content, 30000),
          };
          if (typeof item.readyToDraft !== "undefined") msg.readyToDraft = !!item.readyToDraft;
          return msg;
        })
        .filter(function (item) { return String(item.content || "").trim(); })
    : [];
  return {
    messages: messages,
    outline: cleanString(source.outline, 30000),
    ready: !!source.ready,
    startedAt: cleanTimestamp(source.startedAt),
    confirmedAt: cleanTimestamp(source.confirmedAt),
  };
}

export function isEmptyScriptConsultState(value) {
  var state = normalizeScriptConsultState(value);
  return state.messages.length === 0
    && state.outline === ""
    && !state.ready
    && !state.startedAt
    && !state.confirmedAt;
}

