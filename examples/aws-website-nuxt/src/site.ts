// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — bucket-name env var + IAM onto the server Lambda) and the
// middleware mount (server/middleware/alchemy.ts) imports it inside the
// nitro server bundle to serve `/api/*`.
//
// Narrow subpath imports only (`alchemy/AWS/S3`, not `alchemy/AWS`): this
// module is compiled by nitro into the server bundle and evaluated by the
// nitro dev worker — the provider barrel would drag the whole IaC engine
// along with it.
import * as S3 from "alchemy/AWS/S3";
import { Nuxt } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import { passthrough } from "alchemy/serve";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * S3 bucket bound by the site's program. `remote()` keeps the bucket REAL
 * even under `alchemy dev` — the dev server's capability clients hit AWS
 * directly with your ambient credentials.
 */
export const SiteData = S3.Bucket("SiteData", {
  forceDestroy: true,
}).pipe(remote());

/**
 * One Lambda serves the Nuxt app AND the Effect program's API. On Nuxt
 * the effect `fetch` mounts explicitly: the server middleware at
 * `server/middleware/alchemy.ts` (`toEventHandler` from
 * `alchemy/serve/nitro`) is compiled by nitro itself, so it runs in the
 * deployed Lambda and under `nuxt dev` alike. The middleware offers every
 * request; a `passthrough` lets nitro's own handlers (like `/api/hello`)
 * keep answering.
 */
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  {
    main: import.meta.url,
    forceDestroy: true,
    server: {
      environment: {
        GREETING: "Hello from alchemy",
      },
    },
  },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` is path-shaped inside the effect fetch; the base
        // makes the parse total either way.
        const url = new URL(request.url, "http://site");
        if (url.pathname === "/api/message") {
          const put = url.searchParams.get("put");
          if (put !== null) {
            yield* putObject({ Key: "message", Body: put }).pipe(Effect.orDie);
          }
          const object = yield* getObject({ Key: "message" }).pipe(
            Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
            Effect.orDie,
          );
          const message =
            object?.Body === undefined
              ? null
              : yield* Stream.mkString(Stream.decodeText(object.Body)).pipe(
                  Effect.orDie,
                );
          return yield* HttpServerResponse.json({ message });
        }
        // Typed "not mine": nitro's own routes (/, /api/hello, /about)
        // keep answering.
        return yield* passthrough;
      }),
    };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
