import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { KovaPDFError } from "./errors.js";
import type { FileInput } from "./types.js";

export type Prepared =
  | { kind: "id"; fileId: string }
  | { kind: "url"; url: string }
  | { kind: "bytes"; blob: Blob; name: string };

const isBlob = (x: unknown): x is Blob => typeof Blob !== "undefined" && x instanceof Blob;

/** A name for bytes with no name: by what the bytes are. */
function guessName(head: Uint8Array): string {
  const s = String.fromCharCode(...head.subarray(0, 5));
  if (s.startsWith("%PDF")) return "file.pdf";
  if (head[0] === 0x89 && s.slice(1, 4) === "PNG") return "file.png";
  if (head[0] === 0xff && head[1] === 0xd8) return "file.jpg";
  if (s.startsWith("PK")) return "file.zip";
  return "file";
}

function httpsOnly(url: string): string {
  if (!/^https:\/\//i.test(url)) throw new KovaPDFError("invalid_input", "Only https:// addresses can be fetched by KovaPDF.");
  return url;
}

/** What a FileInput is: an id, an address for KovaPDF to fetch, or bytes to upload. */
export async function prepare(input: FileInput): Promise<Prepared> {
  if (typeof input === "string") {
    if (/^https?:\/\//i.test(input)) return { kind: "url", url: httpsOnly(input) };
    let info;
    try {
      info = await stat(input);
    } catch {
      throw new KovaPDFError("invalid_input", `There is no file at ${input}.`);
    }
    if (!info.isFile()) throw new KovaPDFError("invalid_input", `${input} is not a file.`);
    const buf = await readFile(input);
    return { kind: "bytes", blob: new Blob([buf]), name: path.basename(input) };
  }
  if (input instanceof URL) {
    if (input.protocol === "file:") return prepare(decodeURIComponent(input.pathname));
    return { kind: "url", url: httpsOnly(input.toString()) };
  }
  if (input instanceof Uint8Array) return { kind: "bytes", blob: new Blob([input as Uint8Array<ArrayBuffer>]), name: guessName(input) };
  if (isBlob(input)) {
    const name = (input as Blob & { name?: string }).name;
    return { kind: "bytes", blob: input, name: name || guessName(new Uint8Array(await input.slice(0, 8).arrayBuffer())) };
  }
  if (input && typeof input === "object") {
    if ("fileId" in input && typeof input.fileId === "string") return { kind: "id", fileId: input.fileId };
    if ("url" in input && typeof input.url === "string") return { kind: "url", url: httpsOnly(input.url) };
    if ("data" in input) {
      const d = input.data;
      const blob = d instanceof Uint8Array ? new Blob([d as Uint8Array<ArrayBuffer>]) : d;
      const name = input.name || (d instanceof Uint8Array ? guessName(d) : "file");
      return { kind: "bytes", blob, name };
    }
  }
  throw new KovaPDFError("invalid_input", "A file must be a path, an https address, bytes, a Blob, { data, name }, { fileId } or { url }.");
}

/** Bytes only (sign requests and verify take the file in the call itself). */
export async function prepareBytes(input: FileInput): Promise<{ blob: Blob; name: string }> {
  const p = await prepare(input);
  if (p.kind !== "bytes") throw new KovaPDFError("invalid_input", "This call needs the file itself: a path, bytes or a Blob.");
  return { blob: p.blob, name: p.name };
}

/** Writes bytes to `target`: a file path, or a folder (then `name` inside it). */
export async function saveBytes(bytes: Uint8Array, target: string, name: string, overwrite = false): Promise<string> {
  let file = target;
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory() || /[\\/]$/.test(target)) {
    await mkdir(target, { recursive: true });
    file = path.join(target, path.basename(name));
  } else {
    await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  }
  try {
    await writeFile(file, bytes, { flag: overwrite ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new KovaPDFError("file_exists", `${file} already exists. Choose another name, or allow overwriting.`);
    throw err;
  }
  return file;
}
