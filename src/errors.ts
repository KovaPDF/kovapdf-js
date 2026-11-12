/** Friendly words for the refusals an app must never crash on (the ecosystem contract). */
export const FRIENDLY = {
  integration_paused: "KovaPDF has paused connections from this app for now. Nothing was changed. Please try again later, or use https://www.kovapdf.com.",
  tool_paused: "This KovaPDF tool is paused for apps right now. It still works on https://www.kovapdf.com.",
  not_available: "This KovaPDF feature is not available yet.",
  missing_api_key: "No KovaPDF API key was found. Set the KOVAPDF_API_KEY environment variable to a key from your KovaPDF dashboard.",
  timeout: "The job is still running. Ask for it again later with jobs.get(id).",
  network_error: "Could not reach KovaPDF. Check the connection and try again.",
} as const;

/** Every error the SDK throws. Switch on `code`; show `message` to a person. */
export class KovaPDFError extends Error {
  /** A stable code: the API's own (limit_reached, busy, invalid_options, tool_paused...) or the SDK's (not_available, timeout, network_error, invalid_signature, missing_api_key, invalid_input). */
  readonly code: string;
  /** The HTTP status, when the error came from an answer. */
  readonly status?: number;
  /** Seconds to wait before trying again, when the API said so. */
  readonly retryAfter?: number;
  /** The API's own sentence, when the SDK shows a friendlier one. */
  readonly serverMessage?: string;
  /** The whole error body. */
  readonly details?: Record<string, unknown>;
  /** The job, when a job failed or timed out. */
  readonly jobId?: string;

  constructor(code: string, message: string, extra: { status?: number; retryAfter?: number; serverMessage?: string; details?: Record<string, unknown>; jobId?: string; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = "KovaPDFError";
    this.code = code;
    this.status = extra.status;
    this.retryAfter = extra.retryAfter;
    this.serverMessage = extra.serverMessage;
    this.details = extra.details;
    this.jobId = extra.jobId;
  }

  /** True for integration_paused and tool_paused: KovaPDF chose to pause this; do not retry in a loop. */
  get paused(): boolean {
    return this.code === "integration_paused" || this.code === "tool_paused";
  }
}

/** Builds the error for an answer that was not ok. */
export function errorFromResponse(status: number, body: unknown, retryAfterSeconds?: number): KovaPDFError {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const server = typeof b.error === "string" ? b.error : undefined;
  let code = typeof b.code === "string" ? b.code : undefined;
  // A 404 without a code is the answer of a route that is switched off.
  if (status === 404 && !code) code = "not_available";
  code ??= `http_${status}`;
  const friendly = (FRIENDLY as Record<string, string>)[code];
  const retryAfter = typeof b.retryAfter === "number" ? b.retryAfter : retryAfterSeconds;
  return new KovaPDFError(code, friendly ?? server ?? `KovaPDF answered HTTP ${status}.`, {
    status,
    retryAfter: code === "integration_paused" || code === "tool_paused" ? undefined : retryAfter,
    serverMessage: server,
    details: b,
  });
}
