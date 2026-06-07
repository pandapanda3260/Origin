const QUOTE_CHARS = '\u201C\u201D\u2018\u2019\u0022\u0027\u300C\u300D\u300E\u300F';
const OPEN_PUNCT = new Set(Array.from('\u201C\u2018\u300C\u300E\uFF08\u300A\u3008\u3010\u3014\u3016\u301D'));
const CLOSE_PUNCT = new Set(Array.from('\uFF0C\u3001\u3002\uFF01\uFF1F\uFF1B\uFF1A\uFF09\u300D\u300F\u201D\u2019,.;:!?)]}\u300B\u3009\u3011\u3015\u3017\u301E'));
const WEAK_END_PUNCT_RE = /(?:[\uFF0C\u3001\u3002,.]|\u2026)+$/;
const DASH_EDGE_RE = /^[\u2013\u2014\u2015-]+|[\u2013\u2014\u2015-]+$/g;
const DASH_ONLY_RE = /^[\s\u2013\u2014\u2015-]+$/;
const SPEAKER_RE = /([^\uFF1A:\s\u201C\u201D\u2018\u2019\u0022\u0027\u300C\u300D\u300E\u300F]{1,24})[\uFF1A:]/g;
const LEADING_SPEAKER_RE = /^[^\uFF1A:\s\u201C\u201D\u2018\u2019\u0022\u0027\u300C\u300D\u300E\u300F]{1,24}[\uFF1A:]\s*/;
const ALNUM_RE = /[A-Za-z0-9]/;
const SUBTITLE_LAYOUT_DEFAULTS = Object.freeze({
  fontSize: 44,
  horizontalMarginRatio: 0.08,
  portraitTopRatio: 0.72,
  landscapeTopRatio: 0.85,
  squareTopRatio: 0.8,
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function resolveSubtitleLayoutSpec(opts = {}) {
  const width = Math.max(1, finiteNumber(opts.width, 1080));
  const height = Math.max(1, finiteNumber(opts.height, 1920));
  const ratio = width / height;
  const orientation = ratio >= 1.2 ? 'landscape' : (ratio <= 0.84 ? 'portrait' : 'square');
  const defaultTopRatio = orientation === 'landscape'
    ? SUBTITLE_LAYOUT_DEFAULTS.landscapeTopRatio
    : (orientation === 'portrait' ? SUBTITLE_LAYOUT_DEFAULTS.portraitTopRatio : SUBTITLE_LAYOUT_DEFAULTS.squareTopRatio);
  const horizontalMarginRatio = clampNumber(
    finiteNumber(opts.horizontalMarginRatio, SUBTITLE_LAYOUT_DEFAULTS.horizontalMarginRatio),
    0,
    0.24,
  );

  return {
    width,
    height,
    orientation,
    fontSize: Math.max(1, finiteNumber(opts.fontSize, SUBTITLE_LAYOUT_DEFAULTS.fontSize)),
    topRatio: clampNumber(finiteNumber(opts.topRatio, defaultTopRatio), 0.05, 0.95),
    horizontalMarginRatio,
    maxWidthRatio: Math.max(0.2, 1 - horizontalMarginRatio * 2),
  };
}

function trimWrappingQuotes(text) {
  let out = String(text || '').trim();
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    const first = out[0];
    const last = out[out.length - 1];
    if (QUOTE_CHARS.includes(first)) {
      out = out.slice(1).trim();
      changed = true;
    }
    if (QUOTE_CHARS.includes(last)) {
      out = out.slice(0, -1).trim();
      changed = true;
    }
  }
  return out;
}

function isSilentSubtitleText(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (Array.from(raw).every((ch) => QUOTE_CHARS.includes(ch))) return true;
  if (raw === '\u65E0' || raw === '\u6CA1\u6709' || raw.toLowerCase() === 'none') return true;
  return DASH_ONLY_RE.test(raw);
}

function cleanSubtitleText(rawText) {
  let text = String(rawText || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = trimWrappingQuotes(text);
  text = text.replace(LEADING_SPEAKER_RE, '').trim();
  text = trimWrappingQuotes(text);
  if (isSilentSubtitleText(text)) return '';
  text = text.replace(DASH_EDGE_RE, '').trim();
  text = trimWrappingQuotes(text);
  text = text.replace(WEAK_END_PUNCT_RE, '').trim();
  if (isSilentSubtitleText(text)) return '';
  return text;
}

function charCount(text) {
  return Array.from(String(text || '')).length;
}

function sliceChars(chars, start, end) {
  return chars.slice(start, end).join('');
}

function findPunctuationBreak(chars, target, radius) {
  const punct = new Set(Array.from('\uFF0C\u3001\uFF1B\uFF1A\u3002\uFF01\uFF1F,;:!?\u2014\u2013\u2015'));
  let best = -1;
  for (let offset = 0; offset <= radius; offset += 1) {
    const left = target - offset;
    if (left > 0 && left < chars.length && punct.has(chars[left - 1])) {
      best = left;
      break;
    }
    const right = target + offset;
    if (right > 0 && right < chars.length && punct.has(chars[right - 1])) {
      best = right;
      break;
    }
  }
  return best;
}

function adjustSubtitleBreak(chars, breakAt) {
  let idx = Math.max(1, Math.min(chars.length - 1, breakAt));
  while (idx < chars.length && CLOSE_PUNCT.has(chars[idx])) idx += 1;
  while (idx > 1 && OPEN_PUNCT.has(chars[idx - 1])) idx -= 1;

  if (ALNUM_RE.test(chars[idx - 1] || '') && ALNUM_RE.test(chars[idx] || '')) {
    let right = idx;
    while (right < chars.length && ALNUM_RE.test(chars[right])) right += 1;
    if (right < chars.length && right - idx <= 8) return right;
    let left = idx;
    while (left > 1 && ALNUM_RE.test(chars[left - 1])) left -= 1;
    if (idx - left <= 8) return left;
  }
  return Math.max(1, Math.min(chars.length - 1, idx));
}

function wrapSubtitleText(text, opts = {}) {
  const maxLineChars = Math.max(6, Number(opts.maxLineChars) || 16);
  const maxLines = Math.max(1, Number(opts.maxLines) || 2);
  const chars = Array.from(text);
  if (chars.length <= maxLineChars || maxLines === 1) return [text];

  const lines = [];
  let rest = chars;
  while (rest.length > maxLineChars && lines.length < maxLines - 1) {
    const target = Math.min(maxLineChars, Math.max(1, Math.round(rest.length / (maxLines - lines.length))));
    const punctBreak = findPunctuationBreak(rest, target, 5);
    const breakAt = adjustSubtitleBreak(rest, punctBreak > 0 ? punctBreak : target);
    const line = sliceChars(rest, 0, breakAt).trim();
    if (line) lines.push(line);
    rest = rest.slice(breakAt);
  }
  const tail = rest.join('').trim();
  if (tail) lines.push(tail);
  return lines.filter(Boolean);
}

export function formatSubtitleDisplayText(rawText, opts = {}) {
  const cleaned = cleanSubtitleText(rawText);
  if (!cleaned) return '';
  return wrapSubtitleText(cleaned, opts).join('\n');
}

export function splitSubtitleDialogueLines(rawDialogue, opts = {}) {
  const raw = String(rawDialogue || '').trim();
  if (!raw) return [];
  const anchors = [];
  let match;
  SPEAKER_RE.lastIndex = 0;
  while ((match = SPEAKER_RE.exec(raw)) !== null) {
    anchors.push({ speaker: match[1].trim(), textStart: match.index + match[0].length });
  }

  if (!anchors.length) {
    const text = formatSubtitleDisplayText(raw, opts);
    return text ? [text] : [];
  }

  const out = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const cur = anchors[i];
    const nextStart = i + 1 < anchors.length
      ? anchors[i + 1].textStart - anchors[i + 1].speaker.length - 1
      : raw.length;
    const text = formatSubtitleDisplayText(raw.slice(cur.textStart, nextStart), opts);
    if (text) out.push(text);
  }
  return out;
}

export function extractSubtitleLinesFromPrompt(prompt, opts = {}) {
  const raw = String(prompt || '');
  if (!raw) return [];
  const re = new RegExp(
    '[\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z0-9\\u00B7]{0,23}[\\uFF1A:]\\s*[' +
      QUOTE_CHARS +
      ']([^' +
      QUOTE_CHARS +
      '\\n]{1,120}?)[' +
      QUOTE_CHARS +
      ']',
    'g',
  );
  const lines = [];
  let match;
  while ((match = re.exec(raw)) !== null) {
    const text = formatSubtitleDisplayText(match[1] || '', opts);
    if (text) lines.push(text);
  }
  return lines;
}

export function subtitleVisibleCharCount(text) {
  return charCount(String(text || '').replace(/\s+/g, ''));
}
