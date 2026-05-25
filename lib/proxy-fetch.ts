import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

const DEFAULT_PROXY_HOSTS = [
  'api.openai.com',
  'gateway.zerail.com',
  'api-slb.packyapi.com',
  'packyapi.com',
  'ark.cn-beijing.volces.com',
];

type ProxyFetchInit = Omit<RequestInit, 'body'> & {
  body?: BodyInit | Buffer | Uint8Array | ArrayBuffer | null;
};

type PreparedProxyRequest = {
  method: string;
  headers: Record<string, string>;
  payload?: Buffer;
  signal: AbortSignal | null;
};

export function getProxyUrlForRequest(url: string): string {
  const proxyUrl = getConfiguredProxyUrl();
  if (!proxyUrl) return '';

  try {
    const target = new URL(url);
    if (target.protocol !== 'https:') return '';
    const hosts = getProxyHostAllowList();
    if (hosts.has('*') || hosts.has(target.hostname)) return proxyUrl;
    return '';
  } catch {
    return '';
  }
}

export async function postJsonWithProxySupport(
  url: string,
  apiKey: string,
  body: any,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const err = new Error(timeoutMessage);
    err.name = 'AbortError';
    controller.abort(err);
  }, timeoutMs);

  let resp: Response;
  try {
    resp = await fetchViaProxy(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (controller.signal.aborted || e?.name === 'AbortError') throw new Error(timeoutMessage);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const friendly = extractProxyApiErrorMessage(text) || text.slice(0, 500);
    throw new Error(`LLM ${resp.status}: ${friendly}`);
  }

  const json: any = await resp.json();
  if (json?.error) {
    const friendly = (typeof json.error === 'string' ? json.error : json.error?.message) || JSON.stringify(json.error).slice(0, 400);
    throw new Error(`LLM 错误: ${friendly}`);
  }
  return json;
}

export function postJsonStreamRequest(
  url: string,
  apiKey: string,
  body: any,
  signal: AbortSignal,
): Promise<Response> {
  return fetchViaProxy(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

export async function fetchViaProxy(url: string, init: ProxyFetchInit = {}): Promise<Response> {
  const proxyUrl = getProxyUrlForRequest(url);
  if (!proxyUrl) return fetch(url, init as RequestInit);
  const request = await prepareProxyRequest(url, init);
  return fetchViaHttpProxy(url, proxyUrl, request);
}

function getConfiguredProxyUrl(): string {
  return String(
    process.env.AI_API_PROXY ||
    process.env.OPENAI_API_PROXY ||
    '',
  ).trim();
}

function getProxyHostAllowList(): Set<string> {
  const raw = String(
    process.env.AI_API_PROXY_HOSTS ||
    process.env.OPENAI_API_PROXY_HOSTS ||
    '',
  ).trim();
  const hosts = raw
    ? raw.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)
    : DEFAULT_PROXY_HOSTS;
  return new Set(hosts);
}

function fetchViaHttpProxy(url: string, proxyUrl: string, request: PreparedProxyRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxy = new URL(proxyUrl);
    const targetPort = Number(target.port || 443);
    const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
    const { method, payload, signal } = request;
    const requestHeaders = { ...request.headers };
    const proxyRequest = proxy.protocol === 'https:' ? httpsRequest : httpRequest;

    let settled = false;
    let connectReq: ReturnType<typeof httpRequest> | null = null;
    let apiReq: ReturnType<typeof httpsRequest> | null = null;
    let rawSocket: any = null;
    let secureSocket: any = null;

    const destroyAll = (err?: Error) => {
      try { connectReq?.destroy(err); } catch (_) {}
      try { apiReq?.destroy(err); } catch (_) {}
      try { rawSocket?.destroy(err); } catch (_) {}
      try { secureSocket?.destroy(err); } catch (_) {}
    };

    const cleanupAbort = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      destroyAll(err);
      reject(err);
    };

    const onAbort = () => {
      fail(abortErrorFromSignal(signal));
    };

    if (signal?.aborted) {
      reject(abortErrorFromSignal(signal));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const connectHeaders: Record<string, string> = {
      Host: `${target.hostname}:${targetPort}`,
    };
    const auth = proxyAuthorizationHeader(proxy);
    if (auth) connectHeaders['Proxy-Authorization'] = auth;

    connectReq = proxyRequest({
      hostname: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
    });

    connectReq.on('connect', (connectRes, socket) => {
      rawSocket = socket;
      if (connectRes.statusCode !== 200) {
        fail(new Error(`代理 CONNECT 失败（HTTP ${connectRes.statusCode || 'unknown'}）`));
        return;
      }

      secureSocket = tlsConnect({ socket, servername: target.hostname });
      secureSocket.once('secureConnect', () => {
        if (signal?.aborted) {
          fail(abortErrorFromSignal(signal));
          return;
        }

        requestHeaders.Host = target.host;
        if (payload && !hasHeader(requestHeaders, 'content-length')) {
          requestHeaders['Content-Length'] = String(payload.length);
        }

        apiReq = httpsRequest({
          hostname: target.hostname,
          port: targetPort,
          method,
          path: `${target.pathname}${target.search}`,
          headers: requestHeaders,
          createConnection: () => secureSocket,
        }, (resp) => {
          if (signal?.aborted) {
            fail(abortErrorFromSignal(signal));
            return;
          }

          settled = true;
          cleanupAbort();
          const stream = incomingMessageToWebStream(resp, signal);
          resolve(new Response(stream, {
            status: resp.statusCode || 500,
            statusText: sanitizeProxyStatusText(resp.statusMessage),
            headers: headersFromNodeHeaders(resp.headers),
          }));
        });
        apiReq.on('error', fail);
        apiReq.end(payload);
      });
      secureSocket.on('error', fail);
    });
    connectReq.on('error', fail);
    connectReq.end();
  });
}

export function sanitizeProxyStatusText(value: unknown): string {
  const text = String(value || '');
  const enabled = String(process.env.PROXY_STATUSTEXT_SANITIZE_ENABLED || 'true').toLowerCase() !== 'false'
    && process.env.PROXY_STATUSTEXT_SANITIZE_ENABLED !== '0';
  if (!enabled) return text;
  return text.replace(/[^\x20-\x7E\t]/g, '');
}

async function prepareProxyRequest(url: string, init: ProxyFetchInit): Promise<PreparedProxyRequest> {
  const simplePayload = bodyToBuffer(init.body);
  if (simplePayload || init.body === undefined || init.body === null) {
    return {
      method: String(init.method || 'GET').toUpperCase(),
      headers: headersInitToNodeHeaders(init.headers),
      payload: simplePayload,
      signal: init.signal || null,
    };
  }

  const request = new Request(url, init as RequestInit);
  return {
    method: request.method,
    headers: headersInitToNodeHeaders(request.headers),
    payload: Buffer.from(await request.arrayBuffer()),
    signal: init.signal || request.signal || null,
  };
}

function bodyToBuffer(body: ProxyFetchInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return undefined;
}

function headersInitToNodeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const normalized = new Headers(headers || {});
  normalized.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function proxyAuthorizationHeader(proxy: URL): string {
  if (!proxy.username && !proxy.password) return '';
  const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function headersFromNodeHeaders(headers: Record<string, string | string[] | number | undefined>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else if (value !== undefined) {
      out.set(name, String(value));
    }
  }
  return out;
}

function incomingMessageToWebStream(resp: any, signal: AbortSignal | null): ReadableStream<Uint8Array> {
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: any) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        controller.enqueue(new Uint8Array(buf));
      };
      const onEnd = () => {
        cleanup();
        controller.close();
      };
      const onError = (err: any) => {
        cleanup();
        controller.error(err);
      };
      const onAborted = () => {
        onError(new Error('代理响应中断'));
      };
      const onAbort = () => {
        const err = abortErrorFromSignal(signal);
        cleanup();
        try { resp.destroy?.(err); } catch (_) {}
        controller.error(err);
      };

      cleanup = () => {
        resp.off?.('data', onData);
        resp.off?.('end', onEnd);
        resp.off?.('error', onError);
        resp.off?.('aborted', onAborted);
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      resp.on('data', onData);
      resp.once('end', onEnd);
      resp.once('error', onError);
      resp.once('aborted', onAborted);
    },
    cancel() {
      cleanup();
      try { resp.destroy?.(); } catch (_) {}
    },
  });
}

function abortErrorFromSignal(signal: AbortSignal | null): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function extractProxyApiErrorMessage(text: string): string {
  if (!text) return '';
  try {
    const json = JSON.parse(text);
    return (typeof json?.error === 'string' ? json.error : json?.error?.message)
      || json?.message
      || '';
  } catch {
    return '';
  }
}
