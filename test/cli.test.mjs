import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, RESULT_BYTES } from "./mock-server.mjs";

const CLI = fileURLToPath(new URL("../dist/esm/cli.js", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "kovapdf-cli-"));
const a = path.join(dir, "a.pdf");
const b = path.join(dir, "b.pdf");
writeFileSync(a, "%PDF-1.4\n%a\n");
writeFileSync(b, "%PDF-1.4\n%b\n");
let mock;
before(async () => (mock = await startMock()));
after(() => mock.close());
beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.forced.length = 0;
});

function cli(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, KOVAPDF_API_KEY: "kova_test_cli", KOVAPDF_BASE_URL: mock.base, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("kovapdf compress in.pdf -o out.pdf --level strong", async () => {
  const r = await cli(["compress", a, "-o", "small.pdf", "--level", "strong"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Saved small\.pdf/);
  assert.match(r.stdout, /Done with KovaPDF \(kovapdf\.com\)\./);
  assert.deepEqual(readFileSync(path.join(dir, "small.pdf")), RESULT_BYTES);
  const job = mock.requests.find((q) => q.path === "/jobs");
  assert.deepEqual(JSON.parse(job.body.toString()).options, { level: "strong" });
  assert.match(job.headers["user-agent"], /^kovapdf-cli\/\d+\.\d+\.\d+ \(\+https:\/\/www\.kovapdf\.com\)$/);
  assert.equal(job.headers["x-kovapdf-client"], "sdk");
  // a second run does not overwrite without --force
  const again = await cli(["compress", a, "-o", "small.pdf"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test("kovapdf merge a.pdf b.pdf", async () => {
  const r = await cli(["merge", a, b, "-o", "merged.pdf"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, "merged.pdf")));
  assert.equal(mock.requests.filter((q) => q.path === "/files").length, 2);
  assert.match(r.stdout, /Done with KovaPDF/);
});

test("kovapdf verify in.pdf", async () => {
  const r = await cli(["verify", a]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 signature found/);
  assert.match(r.stdout, /Alex Rivera/);
  assert.match(r.stdout, /Done with KovaPDF/);
  assert.equal(mock.requests[0].path, "/verify");
});

test("kovapdf bijoy-to-unicode: text in, text out, attribution on stderr", async () => {
  const r = await cli(["bijoy-to-unicode", "Avwg evsjvq Mvb MvB"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "আমি বাংলায় গান গাই");
  assert.match(r.stderr, /Done with KovaPDF \(kovapdf\.com\)\./);
  const piped = await cli(["bijoy-to-unicode", "--keep-english", "false"], { input: "Avwg" });
  assert.equal(piped.code, 0, piped.stderr);
  const bodies = mock.requests.filter((q) => q.path === "/jobs").map((q) => JSON.parse(q.body.toString()));
  assert.deepEqual(bodies[1].options, { keepEnglish: false, text: "Avwg" });
});

test("kovapdf tools and help need no key", async () => {
  const r = await cli(["tools"], { env: { KOVAPDF_API_KEY: "" } });
  assert.equal(r.code, 0);
  for (const id of ["compress", "merge", "bijoy-to-unicode", "redact"]) assert.match(r.stdout, new RegExp(`^${id}`, "m"));
  const h = await cli(["redact", "--help"]);
  assert.match(h.stdout, /--match-case/);
  const none = await cli([]);
  assert.equal(none.code, 2);
});

test("friendly refusals: paused, not available, no key, usage", async () => {
  mock.force("POST /files", 403, { error: "Paused.", code: "integration_paused", platform: "sdk" });
  const p = await cli(["compress", a]);
  assert.equal(p.code, 1);
  assert.match(p.stderr, /KovaPDF has paused connections from this app for now/);
  mock.force("POST /jobs", 403, { error: "Paused.", code: "tool_paused", tool: "compress" });
  const tp = await cli(["compress", a]);
  assert.match(tp.stderr, /This KovaPDF tool is paused for apps right now/);
  mock.force("POST /files", 404, { error: "Not found." });
  const n = await cli(["compress", a]);
  assert.match(n.stderr, /This KovaPDF feature is not available yet/);
  const k = await cli(["compress", a], { env: { KOVAPDF_API_KEY: "" } });
  assert.equal(k.code, 1);
  assert.match(k.stderr, /KOVAPDF_API_KEY/);
  const u = await cli(["compress", a, "--level", "tiny"]);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /choose basic, strong, quality/);
  const m = await cli(["merge", a]);
  assert.equal(m.code, 2);
  const x = await cli(["frobnicate"]);
  assert.equal(x.code, 2);
});
