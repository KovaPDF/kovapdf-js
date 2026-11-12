import { KovaPDFError, errorFromResponse, FRIENDLY } from "./errors.js";
import type { ClientIdentity, Transport } from "./types.js";
import { SDK_VERSION } from "./generated/version.js";
import { API_BASE, SITE_URL } from "./generated/tools.js";

/** Statuses that are worth another try (with Retry-After, or backoff). Nothing else is retried. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** Codes that must never be retried, whatever the status. */
const NO_RETRY_CODES = new Set(["integration_paused", "tool_paused"]);
export const BACKOFF_START_MS = 2_000;
export const BACKOFF_CAP_MS = 60_000;
export const MAX_RETRIES = 5;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;

export interface RequestSpec {
  method: "GET" | "POST";
  /** A path under the API base ("/jobs"), or a full URL (download links). */
  path: string;
  query?: Record<string, string | undefined>;
  json?: unknown;
  form?: FormData;
  /** Send the key. Download links and GET /tools need none. */
  auth: boolean;
  idempotencyKey?: string;
  as?: "json" | "bytes";
  signal?: AbortSignal;
}

export interface HttpConfig {
  apiKey?: string;
  baseUrl: string;
  maxConcurrency: number;
  maxRetries: number;
  maxRetryWaitMs: number;
  requestTimeoutMs: number;
  client: ClientIdentity;
  transport: Transport;
}

export const defaultTransport = (): Transport => ({
  fetch: (...a) => globalThis.fetch(...a),
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
});

/** The base URL to use: https only, except for a local test server. */
export function checkBaseUrl(raw: string | undefined): string {
  const base = (raw || API_BASE).replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new KovaPDFError("invalid_input", `The base URL ${JSON.stringify(base)} is not a URL.`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new KovaPDFError("invalid_input", "The base URL must use https:// (plain http is only allowed for localhost), so the key is never sent in the clear.");
  }
  return base;
}

/** Seconds or an HTTP date -> milliseconds to wait, or undefined. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** A tiny counting semaphore: at most `size` calls in flight per client. */
class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.size) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

export class Http {
  readonly config: HttpConfig;
  private readonly sem: Semaphore;
  readonly userAgent: string;

  constructor(config: HttpConfig) {
    this.config = config;
    this.sem = new Semaphore(config.maxConcurrency);
    const c = config.client;
    this.userAgent = `kovapdf-${c.name ?? c.id}/${c.version} (+${SITE_URL})`;
  }

  get transport(): Transport {
    return this.config.transport;
  }

  /** The delay before retry number `n` (0-based) without Retry-After: 2 s doubling to 60 s, with a little jitter. */
  backoff(n: number): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** n);
    return Math.min(BACKOFF_CAP_MS, Math.round(base + base * 0.2 * this.transport.random()));
  }

  url(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(/^https?:\/\//.test(path) ? path : `${this.config.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  headers(spec: RequestSpec): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": this.userAgent,
      "X-KovaPDF-Client": this.config.client.id,
      Accept: spec.as === "bytes" ? "*/*" : "application/json",
    };
    if (spec.auth) {
      if (!this.config.apiKey) throw new KovaPDFError("missing_api_key", FRIENDLY.missing_api_key);
      h.Authorization = `Bearer ${this.config.apiKey}`;
    }
    if (spec.json !== undefined) h["Content-Type"] = "application/json";
    if (spec.idempotencyKey) h["Idempotency-Key"] = spec.idempotencyKey;
    return h;
  }

  async request<T = unknown>(spec: RequestSpec): Promise<T> {
    const headers = this.headers(spec);
    const url = this.url(spec.path, spec.query);
    const release = await this.sem.acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
        const signal = spec.signal ? anySignal([spec.signal, timeout]) : timeout;
        try {
          res = await this.transport.fetch(url, {
            method: spec.method,
            headers,
            body: spec.form ?? (spec.json !== undefined ? JSON.stringify(spec.json) : undefined),
            signal,
          });
        } catch (err) {
          if (spec.signal?.aborted) throw err;
          if (attempt < this.config.maxRetries) {
            await this.transport.sleep(this.backoff(attempt), spec.signal);
            continue;
          }
          throw new KovaPDFError("network_error", FRIENDLY.network_error, { cause: err });
        }
        if (res.ok) {
          if (spec.as === "bytes") return new Uint8Array(await res.arrayBuffer()) as T;
          const text = await res.text();
          return (text ? JSON.parse(text) : {}) as T;
        }
        const body = await res.json().catch(() => ({}));
        const waitMs = parseRetryAfter(res.headers.get("retry-after"), this.transport.now());
        const error = errorFromResponse(res.status, body, waitMs === undefined ? undefined : Math.ceil(waitMs / 1000));
        const retryable = RETRY_STATUS.has(res.status) && !NO_RETRY_CODES.has(error.code);
        if (!retryable || attempt >= this.config.maxRetries) throw error;
        const delay = waitMs ?? this.backoff(attempt);
        if (delay > this.config.maxRetryWaitMs) throw error;
        await this.transport.sleep(Math.max(delay, 0), spec.signal);
      }
    } finally {
      release();
    }
  }
}

/** AbortSignal.any is Node 20+; this works on 18 too. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

export { SDK_VERSION };
