import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GEN = fileURLToPath(new URL("../scripts/generate.mjs", import.meta.url));

test("generated files match the manifest and the OpenAPI file (--check)", (t) => {
  const repoManifest = fileURLToPath(new URL("../../../integrations/generated/manifest.json", import.meta.url));
  try {
    readFileSync(repoManifest);
  } catch {
    t.skip("outside the KovaPDF repository: the sources are not here");
    return;
  }
  const r = spawnSync(process.execPath, [GEN, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the version in the code is the package's", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { SDK_VERSION } = await import("../dist/esm/index.js");
  assert.equal(SDK_VERSION, pkg.version);
});
