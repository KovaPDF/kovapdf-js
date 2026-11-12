// Send a PDF for signature to one person, then list your requests.
//   KOVAPDF_API_KEY=kova_test_... node examples/sign-request.mjs agreement.pdf "Alex Rivera" alex@example.com
// A test key (kova_test_) sends every email to your own address only.
import { KovaPDF, KovaPDFError } from "@kovapdf/sdk";

const [file, name, email] = process.argv.slice(2);
if (!file || !name || !email) {
  console.error('Usage: node examples/sign-request.mjs file.pdf "Signer Name" signer@example.com');
  process.exit(2);
}

const kova = new KovaPDF();
try {
  const request = await kova.signRequests.create({
    file,
    spec: {
      title: "Please sign",
      sequential: false,
      signers: [{ name, email, order: 1 }],
      fields: [{ signer: 0, kind: "SIGNATURE", page: 1, x: 72, y: 640, width: 180, height: 48 }],
    },
  });
  console.log(`Sent request ${request.id} (${request.status})`);
  const all = await kova.signRequests.list();
  console.log(`You have ${all.length} signature request(s).`);
  console.log("Done with KovaPDF (kovapdf.com).");
} catch (err) {
  if (err instanceof KovaPDFError) {
    console.error(`${err.code}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
