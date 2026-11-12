import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";

const EX = fileURLToPath(new URL("../examples/", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "kovapdf-ex-"));
const pdf = path.join(dir, "in.pdf");
writeFileSync(pdf, "%PDF-1.4\n%x\n");
let mock;
before(async () => (mock = await startMock()));
after(() => mock.close());

const run = (file, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(EX, file), ...args], { cwd: dir, env: { PATH: process.env.PATH, KOVAPDF_API_KEY: "kova_test_ex", KOVAPDF_BASE_URL: mock.base } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });

test("examples/compress.mjs", async () => {
  const r = await run("compress.mjs", [pdf, "out.pdf"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(path.join(dir, "out.pdf")));
  assert.match(r.out, /Done with KovaPDF/);
});

test("examples/merge.mjs", async () => {
  const r = await run("merge.mjs", [pdf, pdf, "-o", "merged.pdf"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(path.join(dir, "merged.pdf")));
});

test("examples/sign-request.mjs", async () => {
  const r = await run("sign-request.mjs", [pdf, "Alex Rivera", "alex@example.com"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Sent request sr1/);
});

test("examples/verify-webhook.mjs --demo", async () => {
  const r = await run("verify-webhook.mjs", ["--demo"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Verified request\.completed/);
  assert.match(r.out, /refused: invalid_signature/);
});
