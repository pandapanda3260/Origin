/**
 * 手机号验证码（OTP）
 *
 * 本地开发环境不发真实短信：console.log 打印 6 位数字，便于人工复制。
 * 生产环境通过腾讯云短信发送。
 *
 * 安全点：
 *  - code 存哈希，不存明文
 *  - 5 分钟过期、最多 5 次尝试
 *  - 同一手机号 60 秒只能发一次；IP 10 分钟最多 5 次
 *  - 单手机号 / 单 IP 日限，防短信轰炸
 *  - verify 成功后一次性消费（used=1）
 */

import { hash as bcryptHash, compare as bcryptCompare } from 'bcryptjs';
import { getDb } from './db';
import { sendSmsCode } from './sms';

const OTP_TTL_MS = 5 * 60 * 1000;      // 5 分钟有效期
const MAX_ATTEMPTS = 5;                 // 最多尝试次数
const PHONE_COOLDOWN_MS = 60 * 1000;    // 同手机号 60s 只能发一次
const IP_WINDOW_MS = 10 * 60 * 1000;    // IP 10 分钟
const IP_MAX = 5;                       // 每 IP 每窗口最多 5 次
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PHONE_DAILY_MAX = 10;
const IP_DAILY_MAX = 50;

export type OtpPurpose = 'register' | 'login' | 'reset_password';

function genCode(): string {
  // 6 位数字，前导 0 也合法
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export function normalizePhone(raw: string): string | null {
  const normalized = String(raw || '').replace(/[\s-]/g, '').replace(/^\+?86/, '');
  return /^1[3-9]\d{9}$/.test(normalized) ? normalized : null;
}

export async function sendOtpCode(opts: {
  phone?: string;
  email?: string;
  purpose: OtpPurpose;
  ip?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const db = getDb();
  const phone = normalizePhone(opts.phone || opts.email || '');
  if (!phone) return { ok: false, error: '手机号格式不正确', status: 400 };

  // 冷却：同手机号 60s
  const recent = db
    .prepare<{ phone: string; purpose: string }, { created_at: string }>(
      `SELECT created_at FROM otp_codes
       WHERE phone = @phone AND purpose = @purpose
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ phone, purpose: opts.purpose });
  if (recent) {
    const deltaMs = Date.now() - new Date(recent.created_at).getTime();
    if (deltaMs < PHONE_COOLDOWN_MS) {
      const waitSec = Math.ceil((PHONE_COOLDOWN_MS - deltaMs) / 1000);
      return { ok: false, error: `发送过于频繁，请 ${waitSec} 秒后再试`, status: 429 };
    }
  }

  const dailySince = new Date(Date.now() - DAILY_WINDOW_MS).toISOString();
  const phoneDaily = db
    .prepare<{ phone: string; since: string }, { c: number }>(
      `SELECT COUNT(*) AS c FROM otp_codes
       WHERE phone = @phone AND created_at >= @since`,
    )
    .get({ phone, since: dailySince });
  if (phoneDaily && phoneDaily.c >= PHONE_DAILY_MAX) {
    return { ok: false, error: '该手机号今日验证码请求过多，请明天再试', status: 429 };
  }

  // IP 窗口
  if (opts.ip) {
    const cnt = db
      .prepare<{ ip: string; since: string }, { c: number }>(
        `SELECT COUNT(*) AS c FROM otp_codes
         WHERE ip = @ip AND created_at >= @since`,
      )
      .get({
        ip: opts.ip,
        since: new Date(Date.now() - IP_WINDOW_MS).toISOString(),
      });
    if (cnt && cnt.c >= IP_MAX) {
      return { ok: false, error: 'IP 请求过于频繁，请稍后再试', status: 429 };
    }
    const dailyIp = db
      .prepare<{ ip: string; since: string }, { c: number }>(
        `SELECT COUNT(*) AS c FROM otp_codes
         WHERE ip = @ip AND created_at >= @since`,
      )
      .get({ ip: opts.ip, since: dailySince });
    if (dailyIp && dailyIp.c >= IP_DAILY_MAX) {
      return { ok: false, error: 'IP 今日请求过多，请明天再试', status: 429 };
    }
  }

  const code = genCode();
  const codeHash = await bcryptHash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO otp_codes (phone, code_hash, purpose, ip, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(phone, codeHash, opts.purpose, opts.ip || null, expiresAt);

  try {
    await sendSmsCode(phone, code);
  } catch (e: any) {
    db.prepare(
      `UPDATE otp_codes
          SET used = 1
        WHERE phone = ? AND purpose = ? AND code_hash = ?`,
    ).run(phone, opts.purpose, codeHash);
    console.warn('[otp] sms send failed:', e?.message || String(e));
    return { ok: false, error: '验证码发送失败，请稍后重试', status: 502 };
  }
  return { ok: true };
}

/**
 * 校验 OTP。成功消费（标记 used=1）。返回 true/false。
 * 失败：attempts++；超过 MAX_ATTEMPTS 直接作废。
 */
export async function verifyOtpCode(opts: {
  phone?: string;
  email?: string;
  code: string;
  purpose: OtpPurpose;
}): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const phone = normalizePhone(opts.phone || opts.email || '');
  if (!phone) return { ok: false, error: '手机号格式不正确' };
  const code = (opts.code || '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: '验证码格式不正确' };

  // 取最新一条未过期且未用的记录
  const row = db
    .prepare<{ phone: string; purpose: string; now: string }, any>(
      `SELECT * FROM otp_codes
       WHERE phone = @phone AND purpose = @purpose AND used = 0 AND expires_at > @now
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ phone, purpose: opts.purpose, now: new Date().toISOString() });

  if (!row) return { ok: false, error: '验证码已过期或未发送，请重新获取' };
  if (row.attempts >= MAX_ATTEMPTS) {
    // 作废
    db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
    return { ok: false, error: '验证码尝试次数过多，请重新获取' };
  }

  const match = await bcryptCompare(code, row.code_hash);
  if (!match) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, error: '验证码不正确' };
  }

  // 成功 → 一次性消费
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}
