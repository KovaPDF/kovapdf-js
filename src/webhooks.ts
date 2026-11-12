import { createHmac, timingSafeEqual } from "node:crypto";
import { KovaPDFError } from "./errors.js";
import type { WebhookEvent } from "./generated/api.js";

/**
 * Checks a webhook from KovaPDF and returns its event.
 *
 * KovaPDF signs each delivery with your endpoint's signing secret:
 *
 *   KovaPDF-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * Pass the raw body exactly as received (a string or bytes, before any JSON
 * parsing), the request headers, and the endpoint's secret (whsec_...).
 * Throws KovaPDFError("invalid_signature") when the signature does not
 * match or the timestamp is older than `toleranceSeconds` (default 300).
 */
export function verifyWebhook(
  payload: string | Uint8Array,
  headers: Headers | Record<string, string | string[] | undefined> | string,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): WebhookEvent {
  if (!secret) throw new KovaPDFError("invalid_signature", "No webhook signing secret was given.");
  const header = typeof headers === "string" ? headers : headerValue(headers, "kovapdf-signature");
  if (!header) throw new KovaPDFError("invalid_signature", "The KovaPDF-Signature header is missing.");
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string | undefined]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v!);
  if (!t || !/^\d+$/.test(t) || !sigs.length) throw new KovaPDFError("invalid_signature", "The KovaPDF-Signature header is not in the form t=...,v1=....");
  const body = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const ok = sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    return timingSafeEqual(Buffer.from(s, "hex"), expected);
  });
  if (!ok) throw new KovaPDFError("invalid_signature", "The webhook signature does not match. Check the endpoint's signing secret, and pass the raw body.");
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (tolerance > 0 && Math.abs(now - Number(t)) > tolerance) throw new KovaPDFError("invalid_signature", "The webhook's timestamp is too old. It may be a replay.");
  try {
    return JSON.parse(body) as WebhookEvent;
  } catch {
    throw new KovaPDFError("invalid_signature", "The webhook body is not JSON.");
  }
}

function headerValue(h: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
