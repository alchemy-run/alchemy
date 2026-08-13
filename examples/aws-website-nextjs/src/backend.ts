// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — bucket-name env var + IAM onto the server Lambda) and the
// route-handler mount (app/api/[[...slug]]/route.ts) imports it inside the
// OpenNext server bundle to serve `/api/*`.
//
// Narrow subpath imports only (`alchemy/AWS/S3`, not `alchemy/AWS`): this
// module is compiled by Next into the server bundle — the provider barrel
// would drag the whole IaC engine along with it.
import * as S3 from "alchemy/AWS/S3";
import { Nextjs } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
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
 * One Lambda serves the Next.js app AND the Effect program's API. On
 * Next.js the effect `fetch` mounts explicitly: the catch-all route
 * handler at `app/api/[[...slug]]/route.ts` (`toRouteHandler` from
 * `alchemy/serve/next`) is compiled by Next itself, so it runs in the
 * deployed OpenNext Lambda and under `next dev` alike. More-specific
 * routes like `app/api/hello/route.ts` keep winning over the catch-all —
 * Next's own routing is the fallback.
 */
export default class Site extends Nextjs<Site>()(
  "Nextjs",
  {
    main: import.meta.url,
    // Only hash the files that affect the build, so unchanged sources
    // skip the OpenNext build (and the deploy) entirely.
    memo: {
      include: [
        "app/**",
        "src/**",
        "public/**",
        "package.json",
        "next.config.mjs",
        "postcss.config.mjs",
        "open-next.config.ts",
        "tsconfig.json",
      ],
    },
    forceDestroy: true,
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
        // The catch-all route already owns its URL space, so there is no
        // framework handler to fall back to — answer unknown routes here.
        return yield* HttpServerResponse.json(
          { error: "unknown effect route" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
