import * as S3 from "alchemy/AWS/S3";
import * as Website from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { fileURLToPath } from "node:url";

export const STREAM_MARKER = "SVELTEKIT_AWS_EFFECT_STREAM_MARKER";

/**
 * S3 bucket bound by the effectful site's program. Exported so tests can
 * yield the same declaration (registration is idempotent per FQN) and
 * assert the binding roundtrip out of band via distilled. `remote()`: the
 * AWS dev model — capability bindings hit the REAL cloud with ambient
 * credentials, so the bound bucket opts out of local emulation (a no-op
 * on deploy).
 */
export const SiteData = S3.Bucket("SvelteKitEffectData", {
  forceDestroy: true,
}).pipe(remote());

/**
 * Project root, derived from this module's location so the fixture works
 * from a temp clone. Guarded: inside the deployed Lambda bundle the branch
 * folds to "" (the finish pass defines `__ALCHEMY_RUNTIME__` to true) and
 * the path is inert — `rootDir` is a plan-only prop.
 */
const rootDir = globalThis.__ALCHEMY_RUNTIME__
  ? ""
  : fileURLToPath(new URL("..", import.meta.url));

/**
 * The effectful AWS SvelteKit Website (DESIGN §6.2b / §7-AWS): ONE Lambda
 * serving the kit app AND an Effect-native API. Delivery is the
 * auto-inject (wrapper) tier — the AWS deploy target's generated Lambda
 * entry composes `site.match(request) ?? respond(request)` inside the one
 * `streamifyResponse` wrap. The Effect fetch owns `server.routes`
 * (`/api/*` minus the `!/api/hello` exclusion glob) — strict route
 * ownership:
 *
 * - `/api/effect/s3?key=k[&put=v]` — write/read round-trip through the S3
 *   capability bindings collected at plan time (IAM on the server Lambda's
 *   role; ambient profile credentials in dev).
 * - `/api/effect/stream` — a STREAMED effect response (multi-chunk body):
 *   must ride the Function URL's `RESPONSE_STREAM` pipe deployed, and the
 *   dev middleware's stream pipe in dev.
 * - `/api/hello` is carved OUT of the claim by the exclusion glob, so the
 *   fixture's kit +server endpoint serves it (the effect fetch never sees
 *   the path).
 * - any other `/api/*` path renders as the effect fetch's OWN 404 (the
 *   `RouteNotFound` failure below) — never delegation to kit.
 */
export default class SvelteKitEffectSite extends Website.SvelteKit<SvelteKitEffectSite>()(
  "SvelteKitEffectSite",
  {
    main: import.meta.url,
    rootDir,
    // Strict route ownership with an exclusion glob: the effect fetch owns
    // /api/* EXCEPT /api/hello, which kit's own +server endpoint serves.
    server: { routes: ["/api/*", "!/api/hello"] },
    forceDestroy: true,
    invalidation: { paths: "all", wait: true },
    memo: { include: ["src/**", "package.json"] },
  },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `HttpServerRequest.url` is the path (+ query), not a full URL.
        const url = new URL(request.url, "http://sveltekit-effect");
        if (url.pathname === "/api/effect/s3") {
          const key = url.searchParams.get("key") ?? "current";
          const put = url.searchParams.get("put");
          if (put !== null) {
            yield* putObject({ Key: key, Body: put }).pipe(Effect.orDie);
          }
          const object = yield* getObject({ Key: key }).pipe(Effect.orDie);
          const value =
            object.Body === undefined
              ? undefined
              : yield* Stream.mkString(Stream.decodeText(object.Body)).pipe(
                  Effect.orDie,
                );
          return yield* HttpServerResponse.json({ key, value });
        }
        if (url.pathname === "/api/effect/stream") {
          // A genuinely incremental multi-chunk body: concatenated it
          // spells the stream marker.
          const chunks = Stream.fromIterable([
            "SVELTEKIT_",
            "AWS_EFFECT_",
            "STREAM_MARKER",
          ]).pipe(
            Stream.tap(() => Effect.sleep("25 millis")),
            Stream.map((part) => new TextEncoder().encode(part)),
          );
          return HttpServerResponse.stream(chunks, {
            contentType: "text/plain",
          });
        }
        // Unknown path INSIDE the claim: the effect fetch is authoritative
        // here, so the `RouteNotFound` failure renders as its OWN 404
        // response (what an `HttpRouter` miss produces) — never delegation
        // to kit.
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
