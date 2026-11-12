// Compress a PDF.   KOVAPDF_API_KEY=kova_... node examples/compress.mjs in.pdf [out.pdf]
import { KovaPDF, KovaPDFError } from "@kovapdf/sdk";

const [input, output = "compressed.pdf"] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node examples/compress.mjs in.pdf [out.pdf]");
  process.exit(2);
}

const kova = new KovaPDF(); // the key comes from KOVAPDF_API_KEY
try {
  const result = await kova.compress(input, { level: "strong" }, { saveTo: output, overwrite: true });
  console.log(`Saved ${result.saved.join(", ")}`);
  console.log(result.attribution); // Done with KovaPDF (kovapdf.com).
} catch (err) {
  if (err instanceof KovaPDFError) {
    console.error(`${err.code}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
