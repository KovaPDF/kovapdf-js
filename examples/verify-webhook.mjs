// A webhook receiver that checks KovaPDF's signature before trusting an event.
//   KOVAPDF_WEBHOOK_SECRET=whsec_... node examples/verify-webhook.mjs          listens on PORT (default 3000)
//   node examples/verify-webhook.mjs --demo                                     signs a sample the way KovaPDF does and checks it
import http from "node:http";
import { createHmac } from "node:crypto";
import { verifyWebhook, KovaPDFError } from "@kovapdf/sdk";

if (process.argv.includes("--demo")) {
  const secret = "whsec_demo_only";
  const body = JSON.stringify({ id: "d1", type: "request.completed", createdAt: new Date().toISOString(), data: { request: { id: "sr1" } } });
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const event = verifyWebhook(body, { "KovaPDF-Signature": header }, secret);
  console.log(`Verified ${event.type} (${event.id})`);
  try {
    verifyWebhook(body.replace("sr1", "sr2"), { "KovaPDF-Signature": header }, secret);
  } catch (err) {
    console.log(`A changed body is refused: ${err.code}`);
  }
  process.exit(0);
}

const secret = process.env.KOVAPDF_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set KOVAPDF_WEBHOOK_SECRET to the endpoint's signing secret from your dashboard.");
  process.exit(2);
}
http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const event = verifyWebhook(Buffer.concat(chunks), req.headers, secret); // the raw body, before JSON parsing
        console.log(`${event.type}`, event.data);
        res.writeHead(200).end("ok");
      } catch (err) {
        res.writeHead(err instanceof KovaPDFError ? 400 : 500).end("bad signature");
      }
    });
  })
  .listen(Number(process.env.PORT ?? 3000), () => console.log("Listening for KovaPDF webhooks"));
