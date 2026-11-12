import { randomUUID } from "node:crypto";
import { Http, checkBaseUrl, defaultTransport, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_RETRIES, type RequestSpec } from "./http.js";
import { KovaPDFError, FRIENDLY } from "./errors.js";
import { prepare, prepareBytes, saveBytes } from "./inputs.js";
import { verifyWebhook } from "./webhooks.js";
import { ToolMethods } from "./generated/helpers.js";
import { ENDPOINTS, type FileInfo, type Job, type Me, type SignRequestDetail, type SignRequestSpec, type SignRequestSummary, type VerifyReport, type OperationId } from "./generated/api.js";
import { ATTRIBUTION, SITE_URL, TOOL_IDS, type ToolId, type ToolOptionsMap } from "./generated/tools.js";
import { SDK_VERSION } from "./generated/version.js";
import type { FileInput, KovaPDFOptions, ResultFile, RunOptions, RunResult, WaitOptions } from "./types.js";

export const POLL_START_MS = 2_000;
export const POLL_CAP_MS = 10_000;
const POLL_GROWTH = 1.5;
export const DEFAULT_WAIT_MS = 10 * 60_000;

const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined;

/** "/jobs/{id}" + { id } -> "/jobs/123" */
function pathOf(op: OperationId, params: Record<string, string> = {}): string {
  return ENDPOINTS[op].path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (!v) throw new KovaPDFError("invalid_input", `Missing ${k}.`);
    return encodeURIComponent(v);
  });
}

/**
 * The KovaPDF client.
 *
 *   const kova = new KovaPDF();                        // key from KOVAPDF_API_KEY
 *   const r = await kova.compress("in.pdf", { level: "strong" }, { saveTo: "out.pdf" });
 *   console.log(r.attribution);                        // Done with KovaPDF (kovapdf.com).
 */
export class KovaPDF extends ToolMethods {
  /** @internal */
  readonly http: Http;
  /** When each job was last asked for, so no job is polled faster than every 2 seconds. */
  private readonly lastAsked = new Map<string, number>();

  constructor(options: KovaPDFOptions = {}) {
    super();
    const transport = { ...defaultTransport(), ...options.transport };
    this.http = new Http({
      apiKey: options.apiKey ?? env("KOVAPDF_API_KEY"),
      baseUrl: checkBaseUrl(options.baseUrl ?? env("KOVAPDF_BASE_URL")),
      maxConcurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_CONCURRENCY))),
      maxRetries: Math.min(MAX_RETRIES, Math.max(0, Math.floor(options.maxRetries ?? MAX_RETRIES))),
      maxRetryWaitMs: options.maxRetryWaitMs ?? 120_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      client: options.client ?? { id: "sdk", name: "sdk-js", version: SDK_VERSION },
      transport,
    });
  }

  private call<T>(op: OperationId, spec: Omit<RequestSpec, "method" | "path" | "auth"> & { params?: Record<string, string>; auth?: boolean }): Promise<T> {
    const e = ENDPOINTS[op];
    const { params, ...rest } = spec;
    return this.http.request<T>({ method: e.method as "GET" | "POST", path: pathOf(op, params), auth: spec.auth ?? true, ...rest });
  }

  // ------------------------------------------------------------ files

  readonly files = {
    /** Uploads one file (path, bytes, Blob or https address) and returns its details, with its id. Files are kept for one hour. */
    upload: async (input: FileInput, opts: { signal?: AbortSignal } = {}): Promise<FileInfo> => {
      const p = await prepare(input);
      if (p.kind === "id") return { id: p.fileId };
      if (p.kind === "url") return (await this.call<{ file: FileInfo }>("uploadFile", { json: { url: p.url }, signal: opts.signal })).file;
      const form = new FormData();
      form.append("file", p.blob, p.name);
      return (await this.call<{ file: FileInfo }>("uploadFile", { form, signal: opts.signal })).file;
    },
    /** A file's details, while it is kept. */
    get: async (id: string): Promise<FileInfo> => (await this.call<{ file: FileInfo }>("getFile", { params: { id } })).file,
  };

  // ------------------------------------------------------------ jobs

  readonly jobs = {
    /** Starts a job on uploaded files (ids from files.upload). Answers at once with the queued job. */
    create: async <T extends ToolId>(tool: T, inputs: string[], options?: ToolOptionsMap[T], opts: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<Job> => {
      if (!(TOOL_IDS as readonly string[]).includes(tool)) throw new KovaPDFError("invalid_input", `Unknown tool ${JSON.stringify(tool)}. Tools: ${TOOL_IDS.join(", ")}.`);
      const { job } = await this.call<{ job: Job }>("createJob", {
        json: { tool, inputs, options: options ?? {} },
        idempotencyKey: opts.idempotencyKey ?? randomUUID(),
        signal: opts.signal,
      });
      if (job.id) this.lastAsked.set(job.id, this.http.transport.now());
      return job;
    },
    /** A job's state and, when done, its result. */
    get: async (id: string, opts: { signal?: AbortSignal } = {}): Promise<Job> => {
      const { job } = await this.call<{ job: Job }>("getJob", { params: { id }, signal: opts.signal });
      this.lastAsked.set(id, this.http.transport.now());
      return job;
    },
    /**
     * Waits until a job is done and returns it. Asks no faster than every 2
     * seconds, growing to every 10 (longer when the API says so). Throws
     * KovaPDFError when the job failed, or "timeout" after timeoutMs (default 10 minutes).
     */
    wait: async (id: string, opts: WaitOptions = {}): Promise<Job> => {
      const t = this.http.transport;
      const deadline = t.now() + (opts.timeoutMs ?? DEFAULT_WAIT_MS);
      let interval = POLL_START_MS;
      try {
        for (;;) {
          const last = this.lastAsked.get(id);
          const due = last === undefined ? t.now() : last + interval;
          const wait = Math.max(0, due - t.now());
          if (t.now() + wait > deadline) throw new KovaPDFError("timeout", FRIENDLY.timeout, { jobId: id });
          if (wait > 0) await t.sleep(wait, opts.signal);
          const job = await this.jobs.get(id, { signal: opts.signal });
          opts.onProgress?.(job);
          if (job.state === "done") return job;
          if (job.state === "failed") {
            const e = job.error ?? {};
            throw new KovaPDFError(e.code ?? "failed", e.message ?? "The job failed.", { jobId: id, retryAfter: e.retryAfter, details: e as Record<string, unknown> });
          }
          const asked = (job.retryAfter ?? 0) * 1000;
          interval = Math.max(POLL_START_MS, Math.min(POLL_CAP_MS, interval * (last === undefined ? 1 : POLL_GROWTH)), asked);
        }
      } finally {
        this.lastAsked.delete(id);
      }
    },
  };

  // ------------------------------------------------------------ tools and downloads

  readonly tools = {
    /** The tools the API runs now (no key needed). For the built-in list, import TOOLS. */
    list: () => this.call<{ tools: { id: string; permission: Record<string, string>; files: { min: number; max: number; kinds: string[] } }[] }>("listTools", { auth: false }),
  };

  /** Downloads a result link. No key is sent: the link is its own permission. */
  download(url: string, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    return this.http.request<Uint8Array>({ method: "GET", path: url, auth: false, as: "bytes", signal: opts.signal });
  }

  /**
   * Uploads the inputs, runs the tool, waits for the result and (with
   * saveTo) downloads it. The one-call way to use KovaPDF.
   */
  async run<T extends ToolId>(tool: T, inputs: FileInput[] = [], options?: ToolOptionsMap[T], runOptions: RunOptions = {}): Promise<RunResult> {
    const uploaded = await Promise.all(inputs.map((i) => this.files.upload(i, { signal: runOptions.signal })));
    const created = await this.jobs.create(tool, uploaded.map((f) => f.id!), options, { idempotencyKey: runOptions.idempotencyKey, signal: runOptions.signal });
    const job = created.state === "done" ? created : await this.jobs.wait(created.id!, runOptions);
    const files: ResultFile[] = (job.result?.files ?? [])
      .filter((f) => f.download?.url)
      .map((f) => {
        const url = f.download!.url!;
        const name = f.name ?? "result";
        const bytes = () => this.download(url, { signal: runOptions.signal });
        return {
          id: f.id, name, size: f.size, type: f.type, url, expiresAt: f.download!.expiresAt,
          bytes,
          save: async (target: string, o: { overwrite?: boolean } = {}) => saveBytes(await bytes(), target, name, o.overwrite ?? runOptions.overwrite),
        };
      });
    const saved: string[] = [];
    if (runOptions.saveTo) {
      const intoFolder = files.length > 1;
      for (const f of files) saved.push(await f.save(intoFolder && !/[\\/]$/.test(runOptions.saveTo) ? `${runOptions.saveTo}/` : runOptions.saveTo));
    }
    const report = (job.result?.report ?? null) as Record<string, unknown> | null;
    return {
      jobId: job.id!, tool, job, files, report,
      ...(typeof report?.text === "string" ? { text: report.text } : {}),
      ...(job.untrusted ? { untrusted: job.untrusted } : {}),
      saved,
      attribution: ATTRIBUTION,
      attributionUrl: SITE_URL,
    };
  }

  // ------------------------------------------------------------ the developer API

  /** The account and key this client uses. */
  me(): Promise<Me> {
    return this.call<Me>("getMe", {});
  }

  /** Checks every digital signature in a PDF and returns the report (POST /verify; needs the verify permission). */
  async verify(file: FileInput, opts: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<VerifyReport & { attribution: string }> {
    const { blob, name } = await prepareBytes(file);
    const form = new FormData();
    form.append("file", blob, name);
    const report = await this.call<VerifyReport>("verifyPdf", { form, idempotencyKey: opts.idempotencyKey ?? randomUUID(), signal: opts.signal });
    return { ...report, attribution: ATTRIBUTION };
  }

  readonly signRequests = {
    /** Sends a PDF for signature. Signers get an email from KovaPDF in your account's name. */
    create: async (input: { file: FileInput; spec: SignRequestSpec; idempotencyKey?: string }): Promise<SignRequestDetail> => {
      const { blob, name } = await prepareBytes(input.file);
      const form = new FormData();
      form.append("file", blob, name);
      form.append("spec", JSON.stringify(input.spec));
      return this.call<SignRequestDetail>("createSignRequest", { form, idempotencyKey: input.idempotencyKey ?? randomUUID() });
    },
    /** Your signature requests, newest first. */
    list: async (): Promise<SignRequestSummary[]> => (await this.call<{ requests: SignRequestSummary[] }>("listSignRequests", {})).requests,
    /** One request, with its signers and audit trail. */
    get: (id: string): Promise<SignRequestDetail> => this.call<SignRequestDetail>("getSignRequest", { params: { id } }),
    /** Emails the signers whose turn it is again (or one signer). */
    remind: (id: string, opts: { signerId?: string; idempotencyKey?: string } = {}): Promise<Record<string, unknown>> =>
      this.call("remindSigners", { params: { id }, json: opts.signerId ? { signerId: opts.signerId } : {}, idempotencyKey: opts.idempotencyKey ?? randomUUID() }),
    /** Closes a request. Signers are told. */
    cancel: (id: string, opts: { idempotencyKey?: string } = {}): Promise<Record<string, unknown>> =>
      this.call("cancelSignRequest", { params: { id }, idempotencyKey: opts.idempotencyKey ?? randomUUID() }),
    /** The document: original (as sent), current (signatures so far) or final (sealed). */
    document: (id: string, opts: { version?: "original" | "current" | "final" } = {}): Promise<Uint8Array> =>
      this.call<Uint8Array>("getSignRequestDocument", { params: { id }, query: { version: opts.version }, as: "bytes" }),
  };

  readonly webhooks = {
    /** Checks a webhook's KovaPDF-Signature and returns its event. See verifyWebhook. */
    verify: verifyWebhook,
  };
}
