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
  ring.push({ ts: Date.now(), level, message: message.slice(0, 2000) });
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
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
