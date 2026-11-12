// A small stand-in for the KovaPDF API (node:http), for tests and examples.
// It follows the contract: uploads, jobs queued -> running -> done, download
// links, sign requests, verify, and forced answers (429, 503, paused, 404).
import http from "node:http";
import { randomUUID } from "node:crypto";

export const RESULT_BYTES = Buffer.from("%PDF-1.4\n% result from the mock\n");

export async function startMock(opts = {}) {
  const state = {
    requests: [],
    inFlight: 0,
    maxInFlight: 0,
    forced: [],
    jobs: new Map(),
    files: new Map(),
    jobSteps: opts.jobSteps ?? ["running", "done"],
    delayMs: opts.delayMs ?? 0,
  };
  let base = "";

  const send = (res, status, body, headers = {}) => {
    const isBytes = Buffer.isBuffer(body);
    res.writeHead(status, { "Content-Type": isBytes ? "application/pdf" : "application/json", ...headers });
    res.end(isBytes ? body : JSON.stringify(body));
  };

  const jobView = (job) => {
    const v = { id: job.id, tool: job.tool, state: job.state, createdAt: new Date().toISOString() };
    if (job.state === "queued" || job.state === "running") return { ...v, retryAfter: 3 };
    if (job.state === "failed") return { ...v, error: { code: "invalid_pdf", message: "This file is not a PDF that can be opened." } };
    const text = ["bijoy_to_unicode", "unicode_to_bijoy", "kruti_to_unicode"].includes(job.tool);
    const name = text ? "converted.txt" : `${job.tool}-result.pdf`;
    return {
      ...v,
      result: {
        files: [{ id: randomUUID(), name, size: RESULT_BYTES.length, download: { url: `${base}/downloads/tok-${job.id}`, expiresAt: new Date(Date.now() + 900000).toISOString() } }],
        report: text ? { text: "আমি বাংলায় গান গাই", unconverted: [], keptEnglish: [] } : { pages: 1 },
      },
      attribution: { text: "Done with KovaPDF (kovapdf.com).", url: "https://www.kovapdf.com" },
      ...(text ? { untrusted: { fields: ["result.report"], notice: "The report holds text read from the file." } } : {}),
    };
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/^\/api\/v1/, "");
    const key = `${req.method} ${p}`;
    const record = { method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body, at: Date.now() };
    state.requests.push(record);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const fi = state.forced.findIndex((f) => (typeof f.match === "string" ? key.startsWith(f.match) : f.match.test(key)));
      if (fi >= 0) {
        const f = state.forced[fi];
        if (--f.times <= 0) state.forced.splice(fi, 1);
        return send(res, f.status, f.body ?? {}, f.headers ?? {});
      }
      const needsKey = !p.startsWith("/downloads/") && p !== "/tools";
      if (needsKey && !/^Bearer kova_/.test(req.headers.authorization ?? "")) return send(res, 401, { error: "No API key.", code: "missing_api_key" });

      if (key === "POST /files") {
        let name = "file";
        const ct = req.headers["content-type"] ?? "";
        if (ct.startsWith("application/json")) {
          const j = JSON.parse(body.toString("utf8"));
          name = j.url ? j.url.split("/").pop() : (j.name ?? "file");
        } else {
          name = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1] ?? "file";
        }
        const file = { id: randomUUID(), name, size: body.length, expiresAt: new Date(Date.now() + 3600000).toISOString() };
        state.files.set(file.id, file);
        return send(res, 201, { file });
      }
      if (key === "POST /jobs") {
        const j = JSON.parse(body.toString("utf8"));
        const job = { id: randomUUID(), tool: j.tool, inputs: j.inputs, options: j.options, state: "queued", step: 0 };
        state.jobs.set(job.id, job);
        return send(res, 202, { job: jobView(job) }, { Location: `/api/v1/jobs/${job.id}` });
      }
      let m;
      if (req.method === "GET" && (m = /^\/jobs\/(.+)$/.exec(p))) {
        const job = state.jobs.get(m[1]);
        if (!job) return send(res, 404, { error: "That job was not found.", code: "job_not_found" });
        job.state = state.jobSteps[Math.min(job.step, state.jobSteps.length - 1)];
        job.step++;
        const v = jobView(job);
        return send(res, 200, { job: v }, v.retryAfter ? { "Retry-After": String(v.retryAfter) } : {});
      }
      if (req.method === "GET" && /^\/downloads\//.test(p)) return send(res, 200, RESULT_BYTES);
      if (key === "GET /tools") return send(res, 200, { tools: [{ id: "compress" }] });
      if (key === "GET /me") return send(res, 200, { account: { id: "a1", email: "dev@example.com" }, key: { id: "k1", scopes: ["tools"] } });
      if (key === "POST /verify") return send(res, 200, { pageCount: 1, signatures: [{ signerName: "Alex Rivera", status: "valid" }] });
      if (key === "POST /sign-requests") return send(res, 201, { id: "sr1", title: "Agreement", status: "IN_PROGRESS", signers: [], events: [] });
      if (key === "GET /sign-requests") return send(res, 200, { requests: [{ id: "sr1", title: "Agreement", status: "IN_PROGRESS" }] });
      if ((m = /^\/sign-requests\/([^/]+)$/.exec(p)) && req.method === "GET") return send(res, 200, { id: m[1], title: "Agreement", status: "IN_PROGRESS" });
      if ((m = /^\/sign-requests\/([^/]+)\/remind$/.exec(p))) return send(res, 200, { reminded: 1 });
      if ((m = /^\/sign-requests\/([^/]+)\/cancel$/.exec(p))) return send(res, 200, { id: m[1], status: "CANCELLED" });
      if ((m = /^\/sign-requests\/([^/]+)\/document$/.exec(p))) return send(res, 200, RESULT_BYTES);
      return send(res, 404, { error: "Not found." });
    } finally {
      state.inFlight--;
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;

  return {
    base,
    state,
    get requests() {
      return state.requests;
    },
    /** The next `times` requests whose "METHOD /path" starts with `match` get this answer. */
    force(match, status, body, headers, times = 1) {
      state.forced.push({ match, status, body, headers, times });
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// Run on its own: `node test/mock-server.mjs` prints the base URL and stays up.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const m = await startMock();
  console.log(m.base);
}
