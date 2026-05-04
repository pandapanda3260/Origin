/**
 * 注册邮箱验证码（OTP）
 *
 * 本地开发环境不发真实邮件：console.log 打印 6 位数字，便于人工复制。
 * 生产环境需要把 sendEmail() 里的 TODO 换成 SMTP / Resend / 阿里云等真实发送。
 *
 * 安全点：
 *  - code 存哈希，不存明文
 *  - 5 分钟过期、最多 5 次尝试
 *  - 同一邮箱 60 秒只能发一次；IP 10 分钟最多 5 次
 *  - verify 成功后一次性消费（used=1）
 */

import { hash as bcryptHash, compare as bcryptCompare } from 'bcryptjs';
import { getDb } from './db';

const OTP_TTL_MS = 5 * 60 * 1000;      // 5 分钟有效期
const MAX_ATTEMPTS = 5;                 // 最多尝试次数
const EMAIL_COOLDOWN_MS = 60 * 1000;    // 同邮箱 60s 只能发一次
const IP_WINDOW_MS = 10 * 60 * 1000;    // IP 10 分钟
const IP_MAX = 5;                       // 每 IP 每窗口最多 5 次

export type OtpPurpose = 'register' | 'reset_password';

function genCode(): string {
  // 6 位数字，前导 0 也合法
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export async function sendOtpCode(opts: {
  email: string;
  purpose: OtpPurpose;
  ip?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const db = getDb();
  const email = opts.email.toLowerCase().trim();

  // 冷却：同邮箱 60s
  const recent = db
    .prepare<{ email: string; purpose: string }, { created_at: string }>(
      `SELECT created_at FROM otp_codes
       WHERE email = @email AND purpose = @purpose
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ email, purpose: opts.purpose });
  if (recent) {
    const deltaMs = Date.now() - new Date(recent.created_at).getTime();
    if (deltaMs < EMAIL_COOLDOWN_MS) {
      const waitSec = Math.ceil((EMAIL_COOLDOWN_MS - deltaMs) / 1000);
      return { ok: false, error: `发送过于频繁，请 ${waitSec} 秒后再试`, status: 429 };
    }
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
  }

  const code = genCode();
  const codeHash = await bcryptHash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO otp_codes (email, code_hash, purpose, ip, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(email, codeHash, opts.purpose, opts.ip || null, expiresAt);

  await sendEmail(email, code, opts.purpose);
  return { ok: true };
}

/**
 * 校验 OTP。成功消费（标记 used=1）。返回 true/false。
 * 失败：attempts++；超过 MAX_ATTEMPTS 直接作废。
 */
export async function verifyOtpCode(opts: {
  email: string;
  code: string;
  purpose: OtpPurpose;
}): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const email = opts.email.toLowerCase().trim();
  const code = (opts.code || '').trim();
  if (!/^\d{4,8}$/.test(code)) return { ok: false, error: '验证码格式不正确' };

  // 取最新一条未过期且未用的记录
  const row = db
    .prepare<{ email: string; purpose: string; now: string }, any>(
      `SELECT * FROM otp_codes
       WHERE email = @email AND purpose = @purpose AND used = 0 AND expires_at > @now
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ email, purpose: opts.purpose, now: new Date().toISOString() });

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

/** 开发环境：控制台输出验证码；生产环境：真实邮件发送 */
async function sendEmail(email: string, code: string, purpose: OtpPurpose): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SMTP_HOST) {
    // TODO: 真实 SMTP 发送，需要时接入
    console.log(`[otp] TODO real SMTP for ${email}`);
    return;
  }
  // 开发兜底：打日志
  console.log(`[otp] [${purpose}] ${email} → ${code}  (5 min)`);
}
