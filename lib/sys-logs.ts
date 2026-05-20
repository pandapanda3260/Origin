/**
 * 系统日志环形缓冲（内存版）。
 *
 * 进程内一个 ring buffer，最多保留最近 N 条。
 * 通过 console.log/warn/error 钩进来：
 *   - 启动时调一次 installConsoleHook()
 *   - 之后任何 console.* 调用都会同时存进环里
 *   - /api/auth/admin/logs 读这个环
 *
 * 简单但好用；上线规模大时再换 pino + 文件 + 切割。
 */

import { recordObservabilityEvent } from './observability-events';

const MAX = 1000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  ts: number;
  level: LogLevel;
  message: string;
};

const ring: LogEntry[] = [];
let installed = false;

export function pushLog(level: LogLevel, message: string) {
  const redacted = redactSensitive(message).slice(0, 2000);
  ring.push({ ts: Date.now(), level, message: redacted });
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  if (level === 'warn' || level === 'error') {
    recordObservabilityEvent({
      type: level === 'error' ? 'system_error' : 'system_warn',
      status: level,
      message: redacted,
      meta: { source: 'console' },
    });
  }
}

/**
 * 敏感字段脱敏：
 *  - Authorization: Bearer <xxx> → Bearer [REDACTED]
 *  - ?token=<xxx> / &token=<xxx> → ?token=[REDACTED]
 *  - password / password_hash 键 → [REDACTED]
 *  - Long JWT-ish strings（3 段点分隔 base64）→ [REDACTED]
 *
 * 目的：admin 能读日志也不能顺路读出其他用户的 token / 密码。
 */
function redactSensitive(s: string): string {
  let out = s;
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer [REDACTED]');
  out = out.replace(/([?&])token=[^&\s"']+/gi, '$1token=[REDACTED]');
  out = out.replace(/\b(password|password_hash|passwordHash)\s*[:=]\s*"[^"]*"/gi, '$1:"[REDACTED]"');
  out = out.replace(/\b(password|password_hash|passwordHash)\s*[:=]\s*'[^']*'/gi, '$1:\'[REDACTED]\'');
  // JWT: 三段点分隔 base64（每段 ≥20 字符）
  out = out.replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '[REDACTED_JWT]');
  return out;
}

export function readLogs(opts: { level?: 'warning' | 'all'; lines?: number } = {}) {
  const lines = Math.max(1, Math.min(MAX, opts.lines || 300));
  let arr = ring;
  if (opts.level === 'warning') {
    arr = arr.filter((l) => l.level === 'warn' || l.level === 'error');
  }
  return arr.slice(-lines);
}

export function totalLogs() {
  return ring.length;
}

export function installConsoleHook() {
  if (installed) return;
  installed = true;
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args: any[]) => {
    pushLog('info', args.map(stringify).join(' '));
    orig.log(...args);
  };
  console.info = (...args: any[]) => {
    pushLog('info', args.map(stringify).join(' '));
    orig.info(...args);
  };
  console.warn = (...args: any[]) => {
    pushLog('warn', args.map(stringify).join(' '));
    orig.warn(...args);
  };
  console.error = (...args: any[]) => {
    pushLog('error', args.map(stringify).join(' '));
    orig.error(...args);
  };
  pushLog('info', `[sys-logs] hook installed at ${new Date().toISOString()}`);
}

function stringify(v: any): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
