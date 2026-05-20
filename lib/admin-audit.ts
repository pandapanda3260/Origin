import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_ACTION_CATEGORIES, requireAdmin, type AdminActionCategory } from './admin-auth';
import { getDb, type AdminUserRow } from './db';

const JSON_LIMIT_BYTES = 256 * 1024;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_CLAIM_STALE_MS = 5 * 60 * 1000;

const SAFE_ACTIONS = new Set(['admin.self.change_password', 'admin.self.logout', 'audit.list']);

export type AuditTarget = {
  type?: string;
  ids?: string[];
};

export type AuditDiff = {
  items?: Array<{ id: string; before: unknown; after: unknown }>;
  before?: unknown;
  after?: unknown;
};

export type AdminAuditContext = {
  admin: AdminUserRow;
  body: any;
  dryRun: boolean;
  reason: string;
  idempotencyKey: string;
  requestId: string;
  target: AuditTarget;
  diff: AuditDiff;
  setAuditTarget(target: AuditTarget): void;
  setAuditDiff(diff: AuditDiff): void;
};

type Handler = (req: NextRequest, ctx: AdminAuditContext, routeCtx?: any) => Promise<Response> | Response;

export function withAdminAudit(
  handler: Handler,
  action: string,
  opts: {
    category: AdminActionCategory;
    requireReason?: boolean;
    supportDryRun?: boolean;
    idempotent?: boolean;
    safe?: boolean;
    deriveIdempotencyKey?: (body: any, req: NextRequest) => string;
  },
) {
  if (!ADMIN_ACTION_CATEGORIES.includes(opts.category)) {
    throw new Error(`[admin-audit] invalid category: ${opts.category}`);
  }
  if (opts.safe && !SAFE_ACTIONS.has(action)) {
    throw new Error(`[admin-audit] safe action is not allowlisted: ${action}`);
  }

  return async function audited(req: NextRequest, routeCtx?: any) {
    const admin = await requireAdmin(req).catch(() => null);
    if (!admin) {
      const response = NextResponse.json({ detail: 'unauthorized' }, { status: 401 });
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        safeWriteAdminAction({
          id: randomUUID(),
          requestId: req.headers.get('x-request-id') || randomUUID(),
          adminId: null,
          category: 'audit',
          action,
          target: { type: 'admin_route', ids: [new URL(req.url).pathname] },
          reason: '',
          dryRun: false,
          idempotencyKey: '',
          before: {},
          after: {},
          result: { detail: 'unauthorized' },
          responseStatus: 401,
          status: 'unauthorized',
          errorMsg: 'unauthorized',
          req,
        });
      }
      return response;
    }

    if (!isOriginAllowed(req)) {
      return NextResponse.json({ detail: 'invalid admin origin' }, { status: 403 });
    }

    const body = await readJsonBody(req);
    const requestId = req.headers.get('x-request-id') || randomUUID();
    const providedIdempotencyKey = String(req.headers.get('x-idempotency-key') || body.idempotencyKey || '').trim();
    const derivedIdempotencyKey = String(opts.deriveIdempotencyKey?.(body, req) || '').trim();
    if (providedIdempotencyKey && derivedIdempotencyKey && providedIdempotencyKey !== derivedIdempotencyKey) {
      return NextResponse.json({ detail: 'idempotency_key does not match request payload' }, { status: 400 });
    }
    const idempotencyKey = providedIdempotencyKey || derivedIdempotencyKey;
    const reason = String(req.headers.get('x-admin-reason') || body.reason || '').trim();
    const dryRun = !!opts.supportDryRun && body.dryRun === true;

    if (opts.idempotent && !idempotencyKey) {
      return NextResponse.json({ detail: 'idempotency_key required' }, { status: 400 });
    }
    if (!opts.safe && opts.requireReason !== false && !reason) {
      return NextResponse.json({ detail: 'reason required' }, { status: 400 });
    }

    let idempotencyClaimId = '';
    if (opts.idempotent && idempotencyKey && !dryRun) {
      const replay = readIdempotentReplay(action, idempotencyKey);
      if (replay) return NextResponse.json(replay.payload, { status: replay.status });
      const claim = claimIdempotency(action, idempotencyKey, {
        admin,
        category: opts.category,
        requestId,
        reason,
        req,
      });
      if (claim.replay) return NextResponse.json(claim.replay.payload, { status: claim.replay.status });
      if (claim.inProgress) {
        return NextResponse.json({ detail: 'idempotent request already in progress' }, { status: 409 });
      }
      if (claim.error) {
        return NextResponse.json({ detail: 'admin audit unavailable' }, { status: 500 });
      }
      idempotencyClaimId = claim.id || '';
    }

    const ctx: AdminAuditContext = {
      admin,
      body,
      dryRun,
      reason,
      idempotencyKey,
      requestId,
      target: { type: '', ids: [] },
      diff: { items: [] },
      setAuditTarget(target) { ctx.target = normalizeTarget(target); },
      setAuditDiff(diff) { ctx.diff = diff || { items: [] }; },
    };

    let response: Response = NextResponse.json({ detail: 'admin audit failed before handler response' }, { status: 500 });
    let status = 'completed';
    let errorMsg = '';
    let resultPayload: unknown = { status: 500 };
    let after: unknown = {};
    let before: unknown = {};
    try {
      try {
        response = await handler(req, ctx, routeCtx);
      } catch (error: any) {
        status = 'error';
        errorMsg = error?.message || String(error);
        response = NextResponse.json({ detail: errorMsg }, { status: Number(error?.status || 500) });
      }
      if (status === 'completed' && response.status >= 400) {
        status = 'error';
        errorMsg = `HTTP ${response.status}`;
      }

      resultPayload = await readResponseJson(response);
      after = ctx.diff.after !== undefined
        ? ctx.diff.after
        : Array.isArray(ctx.diff.items)
          ? { items: ctx.diff.items.map((item) => ({ id: item.id, after: item.after })) }
          : {};
      before = ctx.diff.before !== undefined
        ? ctx.diff.before
        : Array.isArray(ctx.diff.items)
          ? { items: ctx.diff.items.map((item) => ({ id: item.id, before: item.before })) }
          : {};
    } finally {
      safeWriteAdminAction({
        id: randomUUID(),
        claimId: idempotencyClaimId || undefined,
        requestId,
        adminId: admin.id,
        category: opts.category,
        action,
        target: ctx.target,
        reason,
        dryRun,
        idempotencyKey,
        before,
        after: dryRun ? plannedAfter(ctx.diff) : after,
        result: resultPayload,
        responseStatus: response.status,
        status,
        errorMsg,
        req,
      });
    }

    return response;
  };
}

export function dryRunPayload(action: string, target: AuditTarget, diff: AuditDiff, warnings: string[] = []) {
  return {
    dryRun: true,
    action,
    target: normalizeTarget(target),
    diff: normalizeDiff(diff),
    blocked: false,
    warnings,
  };
}

function normalizeTarget(target: AuditTarget): AuditTarget {
  return {
    type: String(target?.type || ''),
    ids: Array.isArray(target?.ids) ? target.ids.map(String) : [],
  };
}

function normalizeDiff(diff: AuditDiff): AuditDiff {
  if (Array.isArray(diff?.items)) return { items: diff.items };
  return { items: [{ id: 'target', before: diff?.before ?? null, after: diff?.after ?? null }] };
}

function plannedAfter(diff: AuditDiff) {
  if (diff?.after !== undefined) return diff.after;
  if (Array.isArray(diff?.items)) return { items: diff.items.map((item) => ({ id: item.id, after: item.after })) };
  return {};
}

async function readJsonBody(req: NextRequest): Promise<any> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  try {
    return await req.clone().json();
  } catch {
    return {};
  }
}

async function readResponseJson(response: Response): Promise<any> {
  try {
    return await response.clone().json();
  } catch {
    return { status: response.status };
  }
}

function readIdempotentReplay(action: string, key: string): { payload: any; status: number } | null {
  const row = getDb()
    .prepare<{ action: string; key: string }, any>(
      `SELECT id, result_json, response_status, created_at
         FROM admin_actions
        WHERE action = @action
          AND idempotency_key = @key
          AND dry_run = 0
          AND status = 'completed'
          AND COALESCE(response_status, 200) BETWEEN 200 AND 299
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get({ action, key });
  if (!row) return null;
  if (Date.now() - Date.parse(row.created_at) > IDEMPOTENCY_TTL_MS) return null;
  const responseStatus = Number(row.response_status || 200);
  try {
    return { payload: JSON.parse(row.result_json), status: responseStatus };
  } catch {
    return { payload: { ok: true, idempotentReplay: true, adminActionId: row.id }, status: responseStatus };
  }
}

function claimIdempotency(
  action: string,
  key: string,
  args: {
    admin: AdminUserRow;
    category: string;
    requestId: string;
    reason: string;
    req: NextRequest;
  },
): { id?: string; replay?: { payload: any; status: number }; inProgress?: boolean; error?: boolean } {
  const claimed = insertIdempotencyClaim(action, key, args);
  if (claimed.id) return claimed;
  if (claimed.error && !claimed.uniqueConflict) return { error: true };
  return resolveIdempotencyConflict(action, key, args);
}

function insertIdempotencyClaim(
  action: string,
  key: string,
  args: {
    admin: AdminUserRow;
    category: string;
    requestId: string;
    reason: string;
    req: NextRequest;
  },
): { id?: string; uniqueConflict?: boolean; error?: boolean } {
  const id = randomUUID();
  try {
    getDb()
      .prepare(
        `INSERT INTO admin_actions
          (id, request_id, admin_user_id, category, action, target_type, target_id, reason,
           dry_run, idempotency_key, before_json, after_json, result_json, response_status, status, error_msg, ip, user_agent)
         VALUES
          (@id, @requestId, @adminId, @category, @action, 'idempotency', @targetId, @reason,
           0, @idempotencyKey, '{}', '{}', '{}', 102, 'in_progress', NULL, @ip, @userAgent)`,
      )
      .run({
        id,
        requestId: args.requestId,
        adminId: args.admin.id,
        category: args.category,
        action,
        targetId: key,
        reason: args.reason || null,
        idempotencyKey: key,
        ip: clientIpForAudit(args.req),
        userAgent: args.req.headers.get('user-agent') || null,
      });
    return { id };
  } catch (error: any) {
    if (isSqliteUniqueConstraint(error)) return { uniqueConflict: true };
    console.error('[admin-audit] failed to claim idempotency', error);
    return { error: true };
  }
}

function resolveIdempotencyConflict(
  action: string,
  key: string,
  args: {
    admin: AdminUserRow;
    category: string;
    requestId: string;
    reason: string;
    req: NextRequest;
  },
): { id?: string; replay?: { payload: any; status: number }; inProgress?: boolean; error?: boolean } {
  const row = getDb()
    .prepare<{ action: string; key: string }, any>(
      `SELECT id, status, result_json, response_status, created_at
         FROM admin_actions
        WHERE action = @action
          AND idempotency_key = @key
          AND dry_run = 0
          AND status IN ('in_progress', 'completed')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get({ action, key });
  if (!row) {
    const retry = insertIdempotencyClaim(action, key, args);
    return retry.id ? retry : { inProgress: !!retry.uniqueConflict, error: !retry.uniqueConflict };
  }
  if (row.status === 'completed') {
    const replay = parseIdempotentReplayRow(row);
    if (replay) return { replay };
    return { inProgress: true };
  }
  if (row.status === 'in_progress') {
    if (!isStaleClaim(row.created_at)) return { inProgress: true };
    try {
      getDb()
        .prepare(
          `DELETE FROM admin_actions
            WHERE id = @id
              AND action = @action
              AND idempotency_key = @key
              AND dry_run = 0
              AND status = 'in_progress'`,
        )
        .run({ id: row.id, action, key });
    } catch (error) {
      console.error('[admin-audit] failed to delete stale idempotency claim', error);
      return { error: true };
    }
    const retry = insertIdempotencyClaim(action, key, args);
    if (retry.id) return retry;
    return { inProgress: !!retry.uniqueConflict, error: !retry.uniqueConflict };
  }
  return { inProgress: true };
}

function safeWriteAdminAction(args: WriteAdminActionArgs) {
  try {
    writeAdminAction(args);
  } catch (error) {
    console.error('[admin-audit] failed to persist audit', error);
  }
}

type WriteAdminActionArgs = {
  id: string;
  claimId?: string;
  requestId: string;
  adminId: number | null;
  category: string;
  action: string;
  target: AuditTarget;
  reason: string;
  dryRun: boolean;
  idempotencyKey: string;
  before: unknown;
  after: unknown;
  result: unknown;
  responseStatus: number;
  status: string;
  errorMsg: string;
  req: NextRequest;
};

function writeAdminAction(args: WriteAdminActionArgs) {
  const targetIds = args.target.ids || [];
  const params = {
    id: args.id,
    requestId: args.requestId,
    adminId: args.adminId,
    category: args.category,
    action: args.action,
    targetType: args.target.type || null,
    targetId: targetIds.length === 1 ? targetIds[0] : JSON.stringify(targetIds),
    reason: args.reason || null,
    dryRun: args.dryRun ? 1 : 0,
    idempotencyKey: args.idempotencyKey || null,
    beforeJson: cappedJson(args.before),
    afterJson: cappedJson(args.after),
    resultJson: cappedJson(args.result),
    responseStatus: args.responseStatus,
    status: args.status,
    errorMsg: args.errorMsg || null,
    ip: clientIpForAudit(args.req),
    userAgent: args.req.headers.get('user-agent') || null,
    claimId: args.claimId || '',
  };
  if (args.claimId) {
    const result = getDb()
      .prepare(
        `UPDATE admin_actions
            SET request_id = @requestId,
                admin_user_id = @adminId,
                category = @category,
                action = @action,
                target_type = @targetType,
                target_id = @targetId,
                reason = @reason,
                dry_run = @dryRun,
                idempotency_key = @idempotencyKey,
                before_json = @beforeJson,
                after_json = @afterJson,
                result_json = @resultJson,
                response_status = @responseStatus,
                status = @status,
                error_msg = @errorMsg,
                ip = @ip,
                user_agent = @userAgent
          WHERE id = @claimId`,
      )
      .run(params);
    if (result.changes > 0) return;
  }
  getDb()
    .prepare(
      `INSERT INTO admin_actions
        (id, request_id, admin_user_id, category, action, target_type, target_id, reason,
         dry_run, idempotency_key, before_json, after_json, result_json, response_status, status, error_msg, ip, user_agent)
       VALUES
        (@id, @requestId, @adminId, @category, @action, @targetType, @targetId, @reason,
         @dryRun, @idempotencyKey, @beforeJson, @afterJson, @resultJson, @responseStatus, @status, @errorMsg, @ip, @userAgent)`,
    )
    .run(params);
}

function parseIdempotentReplayRow(row: any): { payload: any; status: number } | null {
  if (!row) return null;
  if (Date.now() - Date.parse(row.created_at) > IDEMPOTENCY_TTL_MS) return null;
  const responseStatus = Number(row.response_status || 200);
  if (responseStatus < 200 || responseStatus > 299) return null;
  try {
    return { payload: JSON.parse(row.result_json), status: responseStatus };
  } catch {
    return { payload: { ok: true, idempotentReplay: true, adminActionId: row.id }, status: responseStatus };
  }
}

function isStaleClaim(createdAt: string): boolean {
  const createdMs = Date.parse(createdAt || '');
  if (!Number.isFinite(createdMs)) return true;
  return Date.now() - createdMs > IDEMPOTENCY_CLAIM_STALE_MS;
}

function cappedJson(value: unknown): string {
  const raw = JSON.stringify(value ?? {});
  if (Buffer.byteLength(raw, 'utf8') <= JSON_LIMIT_BYTES) return raw;
  const envelope = { data: '', truncated: true };
  const empty = JSON.stringify(envelope);
  const available = Math.max(0, JSON_LIMIT_BYTES - Buffer.byteLength(empty, 'utf8'));
  envelope.data = Buffer.from(raw).subarray(0, available).toString('utf8');
  let capped = JSON.stringify(envelope);
  while (Buffer.byteLength(capped, 'utf8') > JSON_LIMIT_BYTES && envelope.data.length > 0) {
    envelope.data = envelope.data.slice(0, Math.max(0, envelope.data.length - 256));
    capped = JSON.stringify(envelope);
  }
  return capped;
}

function isOriginAllowed(req: NextRequest): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.get('origin') || '';
  const allowed = allowedOrigins();
  return !!origin && allowed.includes(origin);
}

function allowedOrigins(): string[] {
  const raw = String(process.env.ADMIN_ALLOWED_ORIGINS || '').trim();
  if (raw) return raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production') return [];
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

function clientIpForAudit(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for') || '';
  const firstForwarded = forwarded.split(',')[0]?.trim();
  return firstForwarded || req.headers.get('x-real-ip') || (req as any).ip || null;
}

function isSqliteUniqueConstraint(error: any): boolean {
  const code = String(error?.code || '');
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(String(error?.message || ''));
}
