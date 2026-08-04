# Cloudflare R2 — Presigned URL upload

A Worker that hands out SigV4 query-string URLs so the browser can
`PUT` / `GET` R2 objects directly. The R2 access keys stay in the
Worker (delivered as `secret_text` bindings) — the browser only ever
sees a short-lived signed URL.

## Two ways to provision R2 access keys

### A) Zero-touch: rely on `alchemy login`

After `alchemy login`, your Alchemy profile holds a Cloudflare API
token. `Cloudflare.R2.Token` mints a scoped R2 access-key pair on
the first deploy via `POST /accounts/{id}/tokens`, persists the
secret in Alchemy state, and reuses it on every subsequent deploy
— no dashboard interaction, no extra env vars.

```ts
const Media = Cloudflare.R2.Bucket("Media");
const PresignToken = Cloudflare.R2.Token("presign", {
  bucketNames: [Media.bucketName],
});

await PresignWorker.pipe(
  Alchemy.provide(Cloudflare.R2.presignedUrlBindingFromToken(PresignToken)),
);
```

Note: this path works only if the Cloudflare account exposes the
`API Tokens Write` permission and your `alchemy login` OAuth token
was issued with the matching scope. If your account doesn't, mint
keys via the dashboard once (option B).

### B) Manual: dashboard-minted keys

R2 → Manage R2 API Tokens → Create Token (Object Read & Write,
scoped to the buckets you need). Set the two env vars:

```bash
export CLOUDFLARE_R2_ACCESS_KEY_ID="..."
export CLOUDFLARE_R2_SECRET_ACCESS_KEY="..."
```

`CLOUDFLARE_ACCOUNT_ID` is resolved automatically from your Alchemy
profile (set via `alchemy login`). Without an explicit env override
the binding reads the account id from `CloudflareEnvironment`.

## Stack

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/cloudflare";
import * as Effect from "effect/Effect";

const Media = Cloudflare.R2.Bucket("Media");

class PresignWorker extends Cloudflare.Worker<PresignWorker>()(
  "PresignWorker",
  { main: "./src/worker.ts", bindings: { MEDIA: Media }, url: true },
  Effect.gen(function* () {
    const presign = yield* Cloudflare.R2.PresignedUrl(Media);
    return {
      fetch: Effect.gen(function* () {
        const { key, contentType } = (yield* request.json) as {
          key: string;
          contentType: string;
        };
        const { url } = yield* presign.presignPut(key, {
          contentType,
          expiresIn: 300,
        });
        return HttpServerResponse.json({ url });
      }),
    };
  }).pipe(Alchemy.provide(Cloudflare.R2.PresignedUrlBinding)),
) {}
```

## API

### `POST /sign`

Request:

```json
{ "key": "uploads/photo.png", "contentType": "image/png" }
```

Response:

```json
{ "url": "https://...r2.cloudflarestorage.com/...?X-Amz-Signature=..." }
```

### `GET /file/:key`

Response:

```json
{ "url": "https://...r2.cloudflarestorage.com/...?X-Amz-Signature=..." }
```

## Browser usage

```js
const { url } = await fetch("/sign", {
  method: "POST",
  body: JSON.stringify({
    key: "uploads/photo.png",
    contentType: "image/png",
  }),
}).then((r) => r.json());

await fetch(url, {
  method: "PUT",
  body: file,
  headers: { "Content-Type": "image/png" },
});
```

## Commands

```bash
bun install
bun run dev
bun run deploy
bun run destroy
```