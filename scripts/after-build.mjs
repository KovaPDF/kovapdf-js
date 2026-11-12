// Marks dist/cjs as CommonJS and makes the CLI executable.
import fs from "node:fs";
fs.writeFileSync(new URL("../dist/cjs/package.json", import.meta.url), JSON.stringify({ type: "commonjs" }) + "\n");
fs.chmodSync(new URL("../dist/esm/cli.js", import.meta.url), 0o755);
