import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock, RESULT_BYTES } from "./mock-server.mjs";
import { KovaPDF, KovaPDFError, FRIENDLY, TOOLS, TOOL_IDS, ATTRIBUTION, SDK_VERSION, verifyWebhook, parseRetryAfter, ENDPOINTS } from "../dist/esm/index.js";

const KEY = "kova_test_abc123";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
let mock;
const dir = mkdtempSync(path.join(tmpdir(), "kovapdf-sdk-"));
const inPdf = path.join(dir, "in.pdf");
writeFileSync(inPdf, PDF);

before(async () => {
  mock = await startMock();
});
after(() => mock.close());
beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.forced.length = 0;
  mock.state.jobSteps = ["running", "done"];
  mock.state.delayMs = 0;
  mock.state.maxInFlight = 0;
});

/** A virtual clock: sleeping moves time on at once, and every sleep and call is recorded. */
function fake(extra = {}) {
  const clock = { t: 1_800_000_000_000, sleeps: [], calls: [] };
  const transport = {
    now: () => clock.t,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 0.5,
    fetch: (url, init) => {
      clock.calls.push({ url: String(url), method: init?.method ?? "GET", t: clock.t });
      return fetch(url, init);
    },
    ...extra,
  };
  return { clock, client: new KovaPDF({ apiKey: KEY, baseUrl: mock.base, transport }) };
}
const jobPolls = (clock) => clock.calls.filter((c) => c.method === "GET" && /\/jobs\//.test(c.url));
const created = (clock) => clock.calls.find((c) => c.method === "POST" && /\/jobs$/.test(c.url));

test("run: upload, job queued -> running -> done, download, attribution", async () => {
  mock.state.jobSteps = ["queued", "running", "running", "done"];
  const { clock, client } = fake();
  const out = path.join(dir, "out.pdf");
  const r = await client.run("compress", [inPdf], { level: "strong" }, { saveTo: out });
  assert.equal(r.tool, "compress");
  assert.equal(r.job.state, "done");
  assert.equal(r.attribution, "Done with KovaPDF (kovapdf.com).");
  assert.equal(r.attribution, ATTRIBUTION);
  assert.equal(r.attributionUrl, "https://www.kovapdf.com");
  assert.equal(r.files.length, 1);
  assert.deepEqual(r.saved, [out]);
  assert.deepEqual(readFileSync(out), RESULT_BYTES);
  const job = mock.requests.find((q) => q.method === "POST" && q.path === "/jobs");
  const body = JSON.parse(job.body.toString());
  assert.equal(body.tool, "compress");
  assert.deepEqual(body.options, { level: "strong" });
  assert.equal(body.inputs.length, 1);
  assert.match(job.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  const upload = mock.requests.find((q) => q.path === "/files");
  assert.match(upload.headers["content-type"], /^multipart\/form-data/);
  assert.match(upload.body.toString("latin1"), /filename="in.pdf"/);
});

test("polling: never faster than every 2 s, growing to 10 s", async () => {
  mock.state.jobSteps = [...Array(9).fill("running"), "done"];
  const { clock, client } = fake();
  await client.run("compress", [PDF]);
  const times = [created(clock).t, ...jobPolls(clock).map((c) => c.t)];
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.equal(gaps.length, 10);
  for (const g of gaps) assert.ok(g >= 2000, `a poll came after ${g} ms`);
  for (const g of gaps) assert.ok(g <= 10000, `a poll waited ${g} ms`);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1], "the wait never shrinks");
  assert.equal(gaps[0], 2000);
  assert.equal(gaps.at(-1), 10000);
});

test("polling: a longer Retry-After from the job is honoured", async () => {
  mock.state.jobSteps = ["running", "running", "done"];
  const { clock, client } = fake();
  const job = await client.jobs.create("compress", ["f1"]);
  // The mock says retryAfter 3: after the first poll the wait is at least 3 s.
  await client.jobs.wait(job.id);
  const times = [created(clock).t, ...jobPolls(clock).map((c) => c.t)];
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.deepEqual(gaps, [2000, 3000, 4500]);
});

test("jobs.wait gives up at the timeout", async () => {
  mock.state.jobSteps = ["running"];
  const { clock, client } = fake();
  const job = await client.jobs.create("compress", ["f1"]);
  const start = clock.t;
  await assert.rejects(client.jobs.wait(job.id, { timeoutMs: 15000 }), (e) => e instanceof KovaPDFError && e.code === "timeout" && e.jobId === job.id);
  assert.ok(clock.t - start <= 15000);
});

test("a failed job throws its code", async () => {
  mock.state.jobSteps = ["running", "failed"];
  const { client } = fake();
  await assert.rejects(client.run("compress", [PDF]), (e) => e instanceof KovaPDFError && e.code === "invalid_pdf" && /not a PDF/.test(e.message) && !!e.jobId);
});

test("headers: Authorization, User-Agent, X-KovaPDF-Client; downloads carry no key", async () => {
  const { client } = fake();
  const r = await client.run("compress", [PDF]);
  assert.deepEqual(Buffer.from(await r.files[0].bytes()), RESULT_BYTES);
  for (const q of mock.requests) {
    assert.equal(q.headers["user-agent"], `kovapdf-sdk-js/${SDK_VERSION} (+https://www.kovapdf.com)`);
    assert.equal(q.headers["x-kovapdf-client"], "sdk");
    if (q.path.startsWith("/downloads/")) assert.equal(q.headers.authorization, undefined);
    else assert.equal(q.headers.authorization, `Bearer ${KEY}`);
  }
  assert.ok(mock.requests.some((q) => q.path.startsWith("/downloads/")));
});

test("an app on the SDK sends its own client id", async () => {
  const c = new KovaPDF({ apiKey: KEY, baseUrl: mock.base, client: { id: "raycast", version: "1.0.0" } });
  await c.me();
  assert.equal(mock.requests[0].headers["x-kovapdf-client"], "raycast");
  assert.equal(mock.requests[0].headers["user-agent"], "kovapdf-raycast/1.0.0 (+https://www.kovapdf.com)");
});

test("429 with Retry-After in seconds waits that long, then succeeds", async () => {
  mock.force("POST /files", 429, { error: "Too many requests.", code: "rate_limited", retryAfter: 7 }, { "Retry-After": "7" });
  const { clock, client } = fake();
  const f = await client.files.upload(PDF);
  assert.ok(f.id);
  assert.deepEqual(clock.sleeps, [7000]);
  assert.equal(mock.requests.filter((q) => q.path === "/files").length, 2);
});

test("Retry-After as an HTTP date", async () => {
  const { clock, client } = fake();
  const at = new Date(clock.t + 12_000).toUTCString();
  mock.force("GET /me", 503, { error: "Busy.", code: "busy" }, { "Retry-After": at });
  await client.me();
  assert.equal(clock.sleeps.length, 1);
  assert.ok(clock.sleeps[0] > 10_000 && clock.sleeps[0] <= 12_000, String(clock.sleeps[0]));
});

test("503 without Retry-After: backoff from 2 s, at most 5 retries, then the error", async () => {
  mock.force("GET /me", 503, { error: "KovaPDF is busy right now.", code: "busy" }, {}, 10);
  const { clock, client } = fake();
  await assert.rejects(client.me(), (e) => e instanceof KovaPDFError && e.code === "busy" && e.status === 503);
  assert.equal(mock.requests.length, 6);
  assert.equal(clock.sleeps.length, 5);
  assert.equal(clock.sleeps[0], 2200);
  for (let i = 0; i < 5; i++) assert.ok(clock.sleeps[i] >= 2000 && clock.sleeps[i] <= 60000);
  for (let i = 1; i < 5; i++) assert.ok(clock.sleeps[i] > clock.sleeps[i - 1]);
});

test("502 and 504 are retried; 400 is not", async () => {
  mock.force("GET /me", 502, {}, {}, 1);
  mock.force("GET /me", 504, {}, {}, 1);
  const { client } = fake();
  await client.me();
  assert.equal(mock.requests.length, 3);
  mock.state.requests.length = 0;
  mock.force("POST /jobs", 400, { error: "Some options are not valid for this tool.", code: "invalid_options" });
  await assert.rejects(client.jobs.create("compress", ["x"], { level: "strong" }), (e) => e.code === "invalid_options" && e.message === "Some options are not valid for this tool.");
  assert.equal(mock.requests.length, 1);
});

test("a Retry-After beyond maxRetryWaitMs is not waited for", async () => {
  mock.force("GET /me", 429, { error: "Daily limit.", code: "daily_limit" }, { "Retry-After": "3600" });
  const { clock, client } = fake();
  await assert.rejects(client.me(), (e) => e.code === "daily_limit" && e.retryAfter === 3600);
  assert.equal(clock.sleeps.length, 0);
});

test("network errors are retried with backoff", async () => {
  let n = 0;
  const { clock, client } = fake({
    fetch: (url, init) => (n++ < 2 ? Promise.reject(new TypeError("fetch failed")) : fetch(url, init)),
  });
  await client.me();
  assert.equal(n, 3);
  assert.deepEqual(clock.sleeps, [2200, 4400]);
});

test("integration_paused: friendly message, no retry", async () => {
  mock.force("POST /files", 403, { error: "Paused.", code: "integration_paused", platform: "sdk" }, {}, 5);
  const { clock, client } = fake();
  await assert.rejects(client.run("compress", [PDF]), (e) => {
    assert.ok(e instanceof KovaPDFError);
    assert.equal(e.code, "integration_paused");
    assert.equal(e.paused, true);
    assert.equal(e.message, "KovaPDF has paused connections from this app for now. Nothing was changed. Please try again later, or use https://www.kovapdf.com.");
    assert.equal(e.serverMessage, "Paused.");
    return true;
  });
  assert.equal(mock.requests.length, 1);
  assert.equal(clock.sleeps.length, 0);
});

test("tool_paused: friendly message, no retry", async () => {
  mock.force("POST /jobs", 403, { error: "Paused.", code: "tool_paused", tool: "compress" }, {}, 5);
  const { client } = fake();
  await assert.rejects(client.run("compress", [PDF]), (e) => e.code === "tool_paused" && e.message === FRIENDLY.tool_paused && e.message.includes("still works on https://www.kovapdf.com"));
  assert.equal(mock.requests.filter((q) => q.path === "/jobs").length, 1);
});

test("404 while the tools API is off: not available", async () => {
  mock.force("POST /files", 404, { error: "Not found." });
  const { client } = fake();
  await assert.rejects(client.files.upload(PDF), (e) => e.code === "not_available" && e.message === "This KovaPDF feature is not available yet.");
  // A 404 with its own code keeps it.
  await assert.rejects(client.jobs.get("00000000-0000-4000-8000-000000000000"), (e) => e.code === "job_not_found");
});

test("concurrency: at most 2 calls at once by default, never more than 4", async () => {
  mock.state.delayMs = 40;
  const two = new KovaPDF({ apiKey: KEY, baseUrl: mock.base });
  await Promise.all(Array.from({ length: 8 }, () => two.me()));
  assert.equal(mock.state.maxInFlight, 2);
  mock.state.maxInFlight = 0;
  const many = new KovaPDF({ apiKey: KEY, baseUrl: mock.base, maxConcurrency: 50 });
  await Promise.all(Array.from({ length: 10 }, () => many.me()));
  assert.equal(mock.state.maxInFlight, 4);
});

test("the key comes from the option or KOVAPDF_API_KEY; none means no call", async () => {
  const saved = process.env.KOVAPDF_API_KEY;
  try {
    delete process.env.KOVAPDF_API_KEY;
    const none = new KovaPDF({ baseUrl: mock.base });
    await assert.rejects(none.me(), (e) => e.code === "missing_api_key");
    assert.equal(mock.requests.length, 0);
    process.env.KOVAPDF_API_KEY = "kova_test_fromenv";
    await new KovaPDF({ baseUrl: mock.base }).me();
    assert.equal(mock.requests[0].headers.authorization, "Bearer kova_test_fromenv");
  } finally {
    if (saved === undefined) delete process.env.KOVAPDF_API_KEY;
    else process.env.KOVAPDF_API_KEY = saved;
  }
});

test("plain http is refused except for localhost", () => {
  assert.throws(() => new KovaPDF({ apiKey: KEY, baseUrl: "http://api.example.com/api/v1" }), (e) => e.code === "invalid_input");
  assert.doesNotThrow(() => new KovaPDF({ apiKey: KEY, baseUrl: "http://localhost:1/api/v1" }));
  assert.equal(new KovaPDF({ apiKey: KEY }).http.config.baseUrl, "https://api.kovapdf.com/api/v1");
});

test("files.upload: a path, bytes, an https address, { fileId }", async () => {
  const { client } = fake();
  await client.files.upload(inPdf);
  await client.files.upload({ data: PDF, name: "named.pdf" });
  const u = await client.files.upload("https://example.com/doc.pdf");
  assert.equal(u.name, "doc.pdf");
  const same = await client.files.upload({ fileId: "abc" });
  assert.equal(same.id, "abc");
  assert.equal(mock.requests.length, 3);
  assert.deepEqual(JSON.parse(mock.requests[2].body.toString()), { url: "https://example.com/doc.pdf" });
  assert.match(mock.requests[1].body.toString("latin1"), /filename="named.pdf"/);
  await assert.rejects(client.files.upload("http://example.com/a.pdf"), (e) => e.code === "invalid_input");
  await assert.rejects(client.files.upload(path.join(dir, "missing.pdf")), (e) => e.code === "invalid_input");
});

test("saving never overwrites unless asked", async () => {
  const { client } = fake();
  const out = path.join(dir, "keep.pdf");
  writeFileSync(out, "mine");
  await assert.rejects(client.run("compress", [PDF], {}, { saveTo: out }), (e) => e.code === "file_exists");
  assert.equal(readFileSync(out, "utf8"), "mine");
  await client.run("compress", [PDF], {}, { saveTo: out, overwrite: true });
  assert.deepEqual(readFileSync(out), RESULT_BYTES);
});

test("generated helpers: one per tool, typed by the manifest", async () => {
  const { client } = fake();
  assert.equal(TOOLS.length, TOOL_IDS.length);
  for (const t of TOOLS) assert.equal(typeof client[t.method], "function", t.method);
  const merged = await client.merge([PDF, PDF]);
  assert.equal(merged.tool, "merge");
  const jobBody = JSON.parse(mock.requests.find((q) => q.path === "/jobs").body.toString());
  assert.equal(jobBody.inputs.length, 2);
  mock.state.requests.length = 0;
  const text = await client.bijoyToUnicode({ text: "Avwg evsjvq Mvb MvB" });
  assert.equal(text.text, "আমি বাংলায় গান গাই");
  assert.ok(text.untrusted);
  assert.equal(mock.requests.filter((q) => q.path === "/files").length, 0);
  assert.deepEqual(JSON.parse(mock.requests.find((q) => q.path === "/jobs").body.toString()), { tool: "bijoy_to_unicode", inputs: [], options: { text: "Avwg evsjvq Mvb MvB" } });
  await assert.rejects(client.jobs.create("nope", []), (e) => e.code === "invalid_input");
});

test("sign requests, verify, me, tools", async () => {
  const { client } = fake();
  const spec = { title: "Agreement", sequential: false, signers: [{ name: "A", email: "a@example.com", order: 1 }], fields: [{ signer: 0, kind: "SIGNATURE", page: 1, x: 1, y: 1, width: 10, height: 10 }] };
  const sr = await client.signRequests.create({ file: PDF, spec });
  assert.equal(sr.id, "sr1");
  const create = mock.requests.at(-1);
  assert.equal(create.path, "/sign-requests");
  assert.ok(create.headers["idempotency-key"]);
  assert.match(create.body.toString(), /name="spec"/);
  assert.match(create.body.toString(), /"title":"Agreement"/);
  assert.equal((await client.signRequests.list()).length, 1);
  assert.equal((await client.signRequests.get("sr1")).id, "sr1");
  await client.signRequests.remind("sr1", { signerId: "s1" });
  assert.deepEqual(JSON.parse(mock.requests.at(-1).body.toString()), { signerId: "s1" });
  assert.equal((await client.signRequests.cancel("sr1")).status, "CANCELLED");
  const doc = await client.signRequests.document("sr1", { version: "final" });
  assert.deepEqual(Buffer.from(doc), RESULT_BYTES);
  assert.equal(mock.requests.at(-1).query.version, "final");
  const report = await client.verify(PDF);
  assert.equal(report.signatures.length, 1);
  assert.equal(report.attribution, ATTRIBUTION);
  assert.equal((await client.me()).key.id, "k1");
  await client.tools.list();
  assert.equal(mock.requests.at(-1).headers.authorization, undefined);
  const paths = mock.requests.map((q) => `${q.method} ${q.path}`);
  assert.deepEqual(paths, ["POST /sign-requests", "GET /sign-requests", "GET /sign-requests/sr1", "POST /sign-requests/sr1/remind", "POST /sign-requests/sr1/cancel", "GET /sign-requests/sr1/document", "POST /verify", "GET /me", "GET /tools"]);
  assert.equal(ENDPOINTS.createJob.path, "/jobs");
});

test("webhooks.verify: accepts a signature made the backend's way, refuses changes and replays", () => {
  // Exactly backend/src/developerApi/webhooks.ts signatureHeader():
  const signatureHeader = (secret, body, timestamp) => `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const secret = "whsec_" + "x".repeat(43);
  const body = JSON.stringify({ id: "d1", type: "signer.signed", createdAt: "2026-11-10T10:00:00.000Z", data: { request: { id: "r1" } } });
  const now = 1_800_000_000_000;
  const t = Math.floor(now / 1000);
  const header = signatureHeader(secret, body, t);
  const ev = verifyWebhook(body, { "kovapdf-signature": header }, secret, { now });
  assert.equal(ev.type, "signer.signed");
  const client = new KovaPDF({ apiKey: KEY });
  assert.equal(client.webhooks.verify(Buffer.from(body), new Headers({ "KovaPDF-Signature": header }), secret, { now }).id, "d1");
  assert.equal(verifyWebhook(body, { "KovaPDF-Signature": [header] }, secret, { now }).id, "d1");
  const bad = (fn) => assert.throws(fn, (e) => e instanceof KovaPDFError && e.code === "invalid_signature");
  bad(() => verifyWebhook(body + " ", { "KovaPDF-Signature": header }, secret, { now }));
  bad(() => verifyWebhook(body, { "KovaPDF-Signature": header }, secret + "y", { now }));
  bad(() => verifyWebhook(body, { "KovaPDF-Signature": header }, secret, { now: now + 301_000 }));
  bad(() => verifyWebhook(body, {}, secret, { now }));
  bad(() => verifyWebhook(body, { "KovaPDF-Signature": "garbage" }, secret, { now }));
});

test("parseRetryAfter", () => {
  assert.equal(parseRetryAfter("5", 0), 5000);
  assert.equal(parseRetryAfter(null, 0), undefined);
  assert.equal(parseRetryAfter("nonsense", 0), undefined);
  const now = Date.parse("2026-11-10T10:00:00Z");
  assert.equal(parseRetryAfter("Tue, 10 Nov 2026 10:00:30 GMT", now), 30000);
});

test("the CommonJS build loads", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../dist/cjs/index.js");
  assert.equal(typeof cjs.KovaPDF, "function");
  assert.equal(cjs.ATTRIBUTION, ATTRIBUTION);
  assert.ok(existsSync(new URL("../dist/esm/index.d.ts", import.meta.url)));
});
