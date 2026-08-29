/**
 * Browser → R2 direct upload via SigV4 presigned URLs.
 *
 * The Worker exposes two routes that mint SigV4 query-string signed
 * URLs against the bound R2 bucket:
 *
 * - `POST /sign` — body `{ key, contentType }` returns `{ url }` for
 *   a presigned `PUT` the browser can `fetch(url, { method: "PUT",
 *   body, headers: { "Content-Type": contentType } })`.
 * - `GET /file/:key` — returns `{ url }` for a presigned `GET` the
 *   browser can download directly.
 *
 * R2 access keys never leave the Worker. `Cloudflare.R2.Token`
 * mints a scoped R2 API token on the first deploy via
 * `POST /accounts/{id}/tokens` using the Cloudflare credentials from
 * `alchemy login`. The secret is persisted in Alchemy state and
 * reused on subsequent deploys. The `presignedUrlBindingFromToken`
 * helper wires the token's outputs into the Worker's four
 * `R2_PRESIGN_*` bindings at deploy time.
 */

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  runtimePresignedUrlClientFromEnv,
  type PresignedUrlClient,
} from "alchemy/Cloudflare/R2/PresignedUrlBinding";

const Media = Cloudflare.R2.Bucket("Media", {
  name: "cloudflare-r2-presigned-upload-media",
  forceDestroy: true,
});

// Alchemy-managed R2 API token. Minted once on first deploy; secret
// persisted in Alchemy state and reused on subsequent deploys. R2 has
// no token-delete API — the token persists until manually revoked in
// the Cloudflare dashboard.
const PresignToken = Cloudflare.R2.Token("presign", {
  bucketNames: [Media.bucketName],
});

class PresignWorker extends Cloudflare.Worker<PresignWorker>()(
  "PresignWorker",
  { main: "./src/worker.ts", bindings: { MEDIA: Media }, url: true },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const env = (request as any).env as Record<string, unknown>;
        const client: PresignedUrlClient = yield* Effect.promise(() =>
          runtimePresignedUrlClientFromEnv(env),
        );

        const url = new URL(request.url, "http://x");
        if (request.method === "POST" && url.pathname === "/sign") {
          const { key, contentType } = (yield* request.json) as {
            key: string;
            contentType: string;
          };
          const { url: presignedUrl } = yield* client.presignPut(key, {
            contentType,
            expiresIn: 300,
          });
          return yield* HttpServerResponse.json({ url: presignedUrl });
        }
        if (request.method === "GET" && url.pathname.startsWith("/file/")) {
          const key = decodeURIComponent(url.pathname.slice("/file/".length));
          const { url: presignedUrl } = yield* client.presignGet(key, {
            expiresIn: 300,
          });
          return yield* HttpServerResponse.json({ url: presignedUrl });
        }
        return yield* HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}

export default Alchemy.Stack(
  "CloudflareR2PresignedUpload",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* PresignWorker.pipe(
      Alchemy.provide(Cloudflare.R2.presignedUrlBindingFromToken(PresignToken)),
    );
    return { url: api.url, bucket: Media.bucketName };
  }),
);