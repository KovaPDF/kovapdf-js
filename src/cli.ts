#!/usr/bin/env node
/**
 * The kovapdf command line tool.
 *
 *   kovapdf compress in.pdf [-o out.pdf] [--level strong]
 *   kovapdf merge a.pdf b.pdf [-o merged.pdf]
 *   kovapdf verify in.pdf
 *   kovapdf bijoy-to-unicode "text" | --file in.txt | (text on stdin)
 *   kovapdf tools
 *   kovapdf <tool> files... [--option value]   every tool in `kovapdf tools`
 *
 * The key comes from the KOVAPDF_API_KEY environment variable only.
 */
import { stat } from "node:fs/promises";
import { KovaPDF } from "./client.js";
import { KovaPDFError } from "./errors.js";
import { ATTRIBUTION, SITE_URL, TOOLS, type OptionField, type ToolInfo } from "./generated/tools.js";
import { SDK_VERSION } from "./generated/version.js";
import { saveBytes } from "./inputs.js";
import type { FileInput } from "./types.js";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  stdin?: () => Promise<string | null>;
  env?: Record<string, string | undefined>;
}

class UsageError extends Error {}

const HELP = `kovapdf ${SDK_VERSION}: work on PDF files with KovaPDF (${SITE_URL}).

Usage:
  kovapdf compress in.pdf [-o out.pdf] [--level basic|strong|quality] [--target-kb N]
  kovapdf merge a.pdf b.pdf [...] [-o merged.pdf]
  kovapdf verify in.pdf [--json]
  kovapdf bijoy-to-unicode "text" | --file in.txt   (or text on stdin)
  kovapdf tools                       every tool and its options
  kovapdf <tool> files... [--option value] [-o out]

Common flags:
  -o, --output PATH   where to save (a file, or a folder for several results)
  --force             overwrite files that exist
  --timeout SECONDS   give up waiting after this long (default 600)
  --json              print the whole result as JSON
  -h, --help          this help
  -v, --version       the version

Set KOVAPDF_API_KEY to a key from your KovaPDF dashboard. Files are deleted
from KovaPDF within an hour; result links work for 15 minutes.`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valueless = new Set(["force", "json", "help", "version"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-o") flags.set("output", argv[++i] ?? "");
    else if (a === "-h") flags.set("help", true);
    else if (a === "-v") flags.set("version", true);
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags.set(name, a.slice(eq + 1));
      else if (valueless.has(name) || argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) flags.set(name, true);
      else flags.set(name, argv[++i]!);
    } else positional.push(a);
  }
  return { positional, flags };
}

function coerce(field: OptionField, raw: string | true): unknown {
  const bad = (why: string) => new UsageError(`--${field.flag}: ${why}`);
  if (field.kind === "boolean") {
    if (raw === true || raw === "true" || raw === "yes" || raw === "1") return true;
    if (raw === "false" || raw === "no" || raw === "0") return false;
    throw bad("use true or false");
  }
  if (raw === true) throw bad("needs a value");
  let v: unknown;
  switch (field.kind) {
    case "integer":
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n) || (field.kind === "integer" && !Number.isInteger(n))) throw bad("needs a number");
      v = n;
      break;
    }
    case "string[]":
      v = raw.split(",").map((s) => s.trim()).filter(Boolean);
      break;
    case "json":
      try {
        v = JSON.parse(raw);
      } catch {
        // "3,1,2" for a list of page numbers
        if (/^[\d,\s]+$/.test(raw)) v = raw.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
        else throw bad("needs JSON");
      }
      break;
    default:
      v = raw;
  }
  if (field.choices) {
    const list = Array.isArray(v) ? v : [v];
    for (const x of list) if (!field.choices.includes(x as never)) throw bad(`choose ${field.choices.join(", ")}`);
  }
  return v;
}

function toolHelp(t: ToolInfo): string {
  const files = t.inputs.min === 0 ? "[text | --file in.txt]" : t.inputs.multi ? "files..." : "file";
  const lines = [`kovapdf ${t.command} ${files}`, `  ${t.title}. ${t.description}`];
  for (const o of t.options) lines.push(`  --${o.flag}${o.kind === "boolean" ? "" : " VALUE"}${o.required ? " (required)" : ""}  ${o.description}${o.choices ? ` [${o.choices.join(", ")}]` : ""}`);
  return lines.join("\n");
}

const fmtSize = (n?: number) => (n === undefined ? "" : n < 1024 ? ` (${n} bytes)` : n < 1024 * 1024 ? ` (${Math.round(n / 1024)} KB)` : ` (${(n / 1024 / 1024).toFixed(1)} MB)`);

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[], io: CliIO = { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n"), stdin: readStdin }): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional.shift();
  if (flags.has("version")) {
    io.out(SDK_VERSION);
    return 0;
  }
  if (!cmd || cmd === "help") {
    io.out(HELP);
    return cmd || flags.has("help") ? 0 : 2;
  }
  try {
    if (cmd === "tools") {
      for (const t of TOOLS) io.out(`${t.command.padEnd(18)} ${t.title}. Options: ${t.optionsNote}`);
      io.out(`\nRun "kovapdf <tool> --help" for a tool's options. Tools run on KovaPDF (${SITE_URL}).`);
      return 0;
    }
    const tool = TOOLS.find((t) => t.command === cmd || t.id === cmd);
    if (!tool) throw new UsageError(`Unknown command ${JSON.stringify(cmd)}. Run "kovapdf tools" for the list.`);
    if (flags.has("help")) {
      io.out(toolHelp(tool));
      return 0;
    }
    const env = io.env ?? process.env;
    const kova = new KovaPDF({ apiKey: env.KOVAPDF_API_KEY, baseUrl: env.KOVAPDF_BASE_URL, client: { id: "sdk", name: "cli", version: SDK_VERSION } });
    const output = typeof flags.get("output") === "string" ? (flags.get("output") as string) : undefined;
    const overwrite = flags.has("force");
    const timeoutRaw = flags.get("timeout");
    const timeoutMs = typeof timeoutRaw === "string" ? Number(timeoutRaw) * 1000 : undefined;
    if (timeoutMs !== undefined && !(timeoutMs > 0)) throw new UsageError("--timeout needs a number of seconds");

    // verify: the direct endpoint, which answers with the report at once.
    if (tool.id === "verify") {
      if (positional.length !== 1) throw new UsageError("verify takes one PDF.");
      const report = await kova.verify(positional[0]!);
      if (flags.has("json")) io.out(JSON.stringify(report, null, 2));
      else io.out(summariseVerify(report));
      io.out(ATTRIBUTION);
      return 0;
    }

    const known = new Set(["output", "force", "timeout", "json", "help", "version", "file", "text"]);
    const options: Record<string, unknown> = {};
    for (const [name, raw] of flags) {
      if (known.has(name) && !tool.options.some((o) => o.flag === name)) continue;
      const field = tool.options.find((o) => o.flag === name || o.name === name);
      if (!field) throw new UsageError(`${tool.command} has no option --${name}. Run "kovapdf ${tool.command} --help".`);
      options[field.name] = coerce(field, raw);
    }

    let inputs: FileInput[] = positional;
    let textOut = false;
    if (tool.inputs.min === 0) {
      textOut = true;
      const file = flags.get("file");
      if (typeof file === "string") inputs = [file];
      else if (options.text === undefined && positional.length) {
        const p = positional.join(" ");
        const isFile = positional.length === 1 && (await stat(p).then((s) => s.isFile()).catch(() => false));
        if (isFile) inputs = [p];
        else {
          options.text = p;
          inputs = [];
        }
      } else if (options.text === undefined) {
        const piped = await (io.stdin ?? readStdin)();
        if (!piped) throw new UsageError(`Give the text: kovapdf ${tool.command} "text", --file in.txt, or pipe it in.`);
        options.text = piped;
        inputs = [];
      } else inputs = [];
    } else {
      if (positional.length < tool.inputs.min) throw new UsageError(`${tool.command} needs ${tool.inputs.min === 1 ? "a file" : `at least ${tool.inputs.min} files`}.`);
      if (positional.length > tool.inputs.max) throw new UsageError(`${tool.command} takes at most ${tool.inputs.max} file${tool.inputs.max === 1 ? "" : "s"}.`);
    }
    for (const o of tool.options) if (o.required && options[o.name] === undefined) throw new UsageError(`${tool.command} needs --${o.flag}.`);

    const result = await kova.run(tool.id, inputs, options as never, { timeoutMs });
    if (flags.has("json")) {
      io.out(JSON.stringify({ jobId: result.jobId, files: result.files.map(({ bytes: _b, save: _s, ...f }) => f), report: result.report, attribution: result.attribution }, null, 2));
      return 0;
    }
    if (textOut && result.text !== undefined && !output) {
      io.out(result.text);
      io.err(ATTRIBUTION);
      return 0;
    }
    const target = output ?? ".";
    const many = result.files.length > 1;
    for (const f of result.files) {
      const bytes = await f.bytes();
      const where = await saveBytes(bytes, many && output && !output.endsWith("/") ? `${output}/` : target, f.name, overwrite);
      io.out(`Saved ${where}${fmtSize(bytes.length)}`);
    }
    if (!result.files.length && result.report) io.out(JSON.stringify(result.report, null, 2));
    io.out(ATTRIBUTION);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`kovapdf: ${err.message}`);
      return 2;
    }
    if (err instanceof KovaPDFError) {
      io.err(`kovapdf: ${err.message}${err.retryAfter ? ` (try again in ${err.retryAfter} s)` : ""}`);
      return 1;
    }
    io.err(`kovapdf: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
}

function summariseVerify(report: Record<string, unknown>): string {
  const sigs = Array.isArray(report.signatures) ? (report.signatures as Record<string, unknown>[]) : [];
  if (!sigs.length) return "No digital signatures were found in this PDF.";
  const lines = [`${sigs.length} signature${sigs.length === 1 ? "" : "s"} found:`];
  sigs.forEach((s, i) => {
    const who = s.signerName ?? s.signer ?? s.name ?? "unknown signer";
    const status = s.status ?? s.verdict ?? s.summary ?? "";
    lines.push(`  ${i + 1}. ${String(who)}${status ? `: ${typeof status === "string" ? status : JSON.stringify(status)}` : ""}`);
  });
  lines.push("Run with --json for the full report.");
  return lines.join("\n");
}

/** Run when executed as a program (not when imported by tests). */
const invoked = process.argv[1] ?? "";
if (/(?:^|[\\/])(?:cli\.(?:c?js|mjs)|kovapdf)$/.test(invoked)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      process.stderr.write(`kovapdf: ${String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
