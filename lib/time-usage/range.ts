export type TimeUsageRangeKey = '1d' | '7d' | '30d' | 'custom';

export type TimeUsageRange = {
  range: TimeUsageRangeKey;
  since: string;
  until: string;
  sinceLocalDate: string;
  untilLocalDate: string;
  timezone: 'Asia/Shanghai';
  timezoneOffset: '+08:00';
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveTimeUsageRange(input: {
  range?: unknown;
  from?: unknown;
  to?: unknown;
  nowMs?: number;
} = {}): TimeUsageRange {
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const requested = String(input.range || '7d').trim();
  if (requested === 'custom') {
    const fromDate = normalizeDateInput(input.from) || localDateFromMs(nowMs);
    const toDate = normalizeDateInput(input.to) || fromDate;
    const ordered = fromDate <= toDate ? { fromDate, toDate } : { fromDate: toDate, toDate: fromDate };
    return {
      range: 'custom',
      since: localDateStartIso(ordered.fromDate),
      until: localDateStartIso(addLocalDays(ordered.toDate, 1)),
      sinceLocalDate: ordered.fromDate,
      untilLocalDate: ordered.toDate,
      timezone: 'Asia/Shanghai',
      timezoneOffset: '+08:00',
    };
  }

  const days = requested === '1d' ? 1 : requested === '30d' ? 30 : 7;
  const today = localDateFromMs(nowMs);
  const startDate = addLocalDays(today, -(days - 1));
  return {
    range: days === 1 ? '1d' : days === 30 ? '30d' : '7d',
    since: localDateStartIso(startDate),
    until: new Date(nowMs).toISOString(),
    sinceLocalDate: startDate,
    untilLocalDate: today,
    timezone: 'Asia/Shanghai',
    timezoneOffset: '+08:00',
  };
}

export function localDateFromMs(ms: number) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function localDateStartIso(yyyyMmDd: string) {
  const [year, month, day] = yyyyMmDd.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS).toISOString();
}

function addLocalDays(yyyyMmDd: string, days: number) {
  const [year, month, day] = yyyyMmDd.split('-').map((part) => Number(part));
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

function normalizeDateInput(value: unknown) {
  const raw = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split('-').map((part) => Number(part));
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return raw;
}
