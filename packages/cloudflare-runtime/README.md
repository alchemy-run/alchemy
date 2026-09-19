# @alchemy.run/cloudflare-runtime

Cloudflare Workers runtime and build integrations for Alchemy.

- `@alchemy.run/cloudflare-runtime/core` — local Workers runtime
- `@alchemy.run/cloudflare-runtime/rolldown` — Rolldown plugin
- `@alchemy.run/cloudflare-runtime/vite` — Vite plugin

## Upstream references

- Cloudflare Workers SDK: [`f9e7727dbef58e71c6b297dc688d3c544cef87cb`](https://github.com/cloudflare/workers-sdk/tree/f9e7727dbef58e71c6b297dc688d3c544cef87cb)

## Local R2 S3 endpoint

Set `RuntimeWorker.r2S3` to development-only credentials to enable presigned
`PUT`, `GET`, and `HEAD` for the Worker's local R2 bindings:

```ts
import { R2Bucket } from "@alchemy.run/cloudflare-runtime/core/bindings";

const url = yield* runtime.start({
  // name, modules, compatibilityDate, compatibilityFlags, ...
  ...worker,
  bindings: [R2Bucket.local({ binding: "UPLOADS", id: "uploads" })],
  r2S3: { accessKeyId: "local-key", secretAccessKey: "local-secret" },
});
const endpoint = R2Bucket.localS3Endpoint(url);
// http://localhost:<port>/cdn-cgi/local/r2/s3/
```

Use a path-style S3 client with `endpoint`, region `auto`, and bucket `uploads`.
Requests share storage with `env.UPLOADS`; no separate emulator or store is
started. Browser preflights and response CORS headers are handled by the endpoint.
Omit `r2S3` to disable HTTP access. Only local bindings in this Worker are exposed.

For Alchemy's `dev.r2S3` configuration, signing examples, and supported operations,
see [local R2 development](https://alchemy.run/cloudflare/local-development/#presigned-r2-uploads-and-downloads).
