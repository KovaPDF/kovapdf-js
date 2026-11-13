# @kovapdf/sdk

The official KovaPDF client for Node.js, with the `kovapdf` command line tool.
Compress, merge, split, reorder, convert, read scans, redact and check the
signatures of PDF files, convert Bangla and Hindi text between Bijoy,
Kruti Dev and Unicode, and send documents for signature.

The work is done by KovaPDF: https://www.kovapdf.com

## Install

```sh
npm install @kovapdf/sdk
```

Node.js 18.17 or newer. No runtime dependencies. ESM and CommonJS, with types.

## Your API key

Make a key in your KovaPDF dashboard (Developer API) and put it in the
environment. The SDK reads `KOVAPDF_API_KEY`; never write a key into code.

```sh
export KOVAPDF_API_KEY=kova_test_...
```

A test key (`kova_test_`) is free to make and stamps its PDFs TEST. A live key
(`kova_live_`) needs API access on your account.

## Use it

```js
import { KovaPDF } from "@kovapdf/sdk";

const kova = new KovaPDF(); // the key comes from KOVAPDF_API_KEY

const result = await kova.compress("report.pdf", { level: "strong" }, { saveTo: "report-small.pdf" });
console.log(result.saved);       // [ 'report-small.pdf' ]
console.log(result.attribution); // Done with KovaPDF (kovapdf.com).
```

Every tool has its own typed method, made from KovaPDF's tool manifest:
`compress`, `merge`, `split`, `organize`, `convert`, `ocr`, `redact`,
`bijoyToUnicode`, `unicodeToBijoy`, `krutiToUnicode` and `verifyJob`.

```js
await kova.merge(["a.pdf", "b.pdf"], {}, { saveTo: "merged.pdf" });
await kova.split("big.pdf", { mode: "range", pages: "1-3,5" }, { saveTo: "out/" });
const { text } = await kova.bijoyToUnicode({ text: "Avwg evsjvq Mvb MvB" });
```

A file can be a path, an https address, bytes (`Buffer`, `Uint8Array`), a
`Blob`, `{ data, name }`, or `{ fileId }` from an earlier upload.

### Step by step

```js
const file = await kova.files.upload("in.pdf");               // kept for one hour
const job = await kova.jobs.create("compress", [file.id], { level: "basic" });
const done = await kova.jobs.wait(job.id, { timeoutMs: 5 * 60_000 });
const bytes = await kova.download(done.result.files[0].download.url); // the link works for 15 minutes
```

`kova.run(tool, inputs, options, runOptions)` does all of that in one call.

### Signature requests and verify

```js
const request = await kova.signRequests.create({
  file: "agreement.pdf",
  spec: {
    title: "Service agreement",
    sequential: false,
    signers: [{ name: "Alex Rivera", email: "alex@example.com", order: 1 }],
    fields: [{ signer: 0, kind: "SIGNATURE", page: 1, x: 72, y: 640, width: 180, height: 48 }],
  },
});
await kova.signRequests.list();
await kova.signRequests.get(request.id);
await kova.signRequests.remind(request.id);
await kova.signRequests.cancel(request.id);
const pdf = await kova.signRequests.document(request.id, { version: "final" });

const report = await kova.verify("signed.pdf"); // every digital signature, checked
```

### Webhooks

```js
import { verifyWebhook } from "@kovapdf/sdk";

// rawBody: the request body exactly as received, before JSON parsing
const event = verifyWebhook(rawBody, req.headers, process.env.KOVAPDF_WEBHOOK_SECRET);
```

It checks the `KovaPDF-Signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`)
and refuses a timestamp older than five minutes.

## Command line

```sh
npx -p @kovapdf/sdk kovapdf compress in.pdf -o out.pdf --level strong
kovapdf merge a.pdf b.pdf -o merged.pdf
kovapdf verify signed.pdf
kovapdf bijoy-to-unicode "Avwg evsjvq Mvb MvB"
echo "Avwg" | kovapdf bijoy-to-unicode
kovapdf tools                    # every tool and its options
kovapdf redact in.pdf --patterns email,phone -o clean.pdf
```

The command prints `Done with KovaPDF (kovapdf.com).` after each result. It
never overwrites a file unless you add `--force`.

## Errors

Every error is a `KovaPDFError` with a stable `code` and a `message` you can
show to a person. A few need care:

| code | what it means |
|---|---|
| `integration_paused` | KovaPDF has paused connections from this kind of app for now. Nothing was changed. Try again later, or use https://www.kovapdf.com. |
| `tool_paused` | This tool is paused for apps right now. It still works on https://www.kovapdf.com. |
| `not_available` | This KovaPDF feature is not available yet. |
| `limit_reached`, `rate_limited`, `daily_limit` | A limit was reached; `retryAfter` says when to try again. |
| `timeout` | The job is still running; ask for it later with `jobs.get(id)`. |

Paused answers are never retried.

## Limits, and how the client behaves

Your account's own limits apply, exactly as on the website; your dashboard
shows them. Files you upload and results are deleted within an hour, and a
result link works for 15 minutes.

The client is gentle with KovaPDF by design:

- at most 2 calls at once per client (you can set up to 4);
- a job is checked no more often than every 2 seconds, slowing to every 10;
- `Retry-After` is always honoured; otherwise it waits 2 seconds, then longer
  (up to a minute), and tries at most 5 more times, only after a busy answer
  or a network error;
- every call says who it is: `User-Agent: kovapdf-sdk-js/<version> (+https://www.kovapdf.com)`
  and `X-KovaPDF-Client: sdk`.

## Attribution

Results carry `attribution: "Done with KovaPDF (kovapdf.com)."`. Please show
it to the person you did the work for, with a link to https://www.kovapdf.com.

## Development

The files in `src/generated/` are made from KovaPDF's tool manifest and
OpenAPI file by `scripts/generate.mjs` (run in the KovaPDF repository).
`npm run generate:check` fails when they drift. `npm test` builds and runs the
tests against a local mock server.

## Licence

MIT for the code (see LICENSE). The KovaPDF name, logos and images are not
covered by it (see NOTICE).
