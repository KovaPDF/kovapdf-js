// Merge PDFs in order.   KOVAPDF_API_KEY=kova_... node examples/merge.mjs a.pdf b.pdf [more.pdf ...] [-o merged.pdf]
import { KovaPDF, KovaPDFError } from "@kovapdf/sdk";

const args = process.argv.slice(2);
const o = args.indexOf("-o");
const output = o >= 0 ? args.splice(o, 2)[1] : "merged.pdf";
if (args.length < 2) {
  console.error("Usage: node examples/merge.mjs a.pdf b.pdf [...] [-o merged.pdf]");
  process.exit(2);
}

const kova = new KovaPDF();
try {
  const result = await kova.merge(args, {}, { saveTo: output, overwrite: true, timeoutMs: 5 * 60_000 });
  console.log(`Saved ${result.saved.join(", ")}`);
  console.log(result.attribution);
} catch (err) {
  if (err instanceof KovaPDFError) {
    console.error(`${err.code}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
