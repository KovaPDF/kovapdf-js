# Security

Please report a security problem in this package, or in KovaPDF itself, to
**support@kovapdf.com** (the contact in https://www.kovapdf.com/.well-known/security.txt).
How we handle files, encryption and reports: https://www.kovapdf.com/security

Please do not open a public issue for a security problem. Tell us what you
found and how to reproduce it; we answer as soon as we can.

## How this package handles your key

- The API key is read from the `apiKey` option or the `KOVAPDF_API_KEY`
  environment variable. It is never written to disk or logged.
- The key is only sent over https (plain http is allowed for `localhost` only,
  for local tests).
- Result download links need no key, and the key is never sent to them.
- There are no runtime dependencies.
