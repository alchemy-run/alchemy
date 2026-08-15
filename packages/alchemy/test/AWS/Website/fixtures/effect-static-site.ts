import * as S3 from "@/AWS/S3";
import * as Website from "@/AWS/Website";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as pathe from "pathe";
import * as Stream from "effect/Stream";

/**
 * The effectful AWS StaticSite fixture (DESIGN §4.2): the Effect program
 * IS the server — an effect-native `AWS.Lambda.Function` built by the
 * ordinary FunctionBundle machinery — and the generated CloudFront edge
 * router forwards the default `server.routes` (`["/api/*"]`) to it BEFORE
 * the static-asset manifest, so the API stays reachable under `spa: true`.
 *
 * This module is evaluated in two worlds: the engine (plan — bindings
 * collect env + IAM onto the server Lambda) and the deployed Lambda (the
 * bundle's virtual entry imports the default export and re-runs the
 * program). Path resolution is plan-only and guarded accordingly.
 */

/**
 * S3 bucket bound by the impl. Exported so tests can yield the same
 * declaration (registration is idempotent per FQN) and assert the binding
 * roundtrip out of band via distilled.
 */
export const SiteData = S3.Bucket("EffectStaticSiteData", {
  forceDestroy: true,
});

// Plan-only: inside the deployed Lambda bundle the branch folds to "" (the
// bundle defines `__ALCHEMY_RUNTIME__` to true) and the paths are inert.
const siteDir = globalThis.__ALCHEMY_RUNTIME__
  ? ""
  : pathe.resolve(import.meta.dirname, "static-site");
const devDir = globalThis.__ALCHEMY_RUNTIME__
  ? ""
  : pathe.resolve(import.meta.dirname, "staticsite-dev");

export default class EffectStaticSite extends Website.StaticSite<EffectStaticSite>()(
  "EffectStaticSite",
  {
    path: siteDir,
    spa: true,
    forceDestroy: true,
    main: import.meta.url,
    invalidation: { paths: "all", wait: true },
    // No explicit `server.routes`: the default (["/api/*"]) must route to
    // the effect fetch at the edge even under `spa: true`.
    //
    // Dev: the frontend is the external dev server; the effect Lambda runs
    // in the local emulator.
    dev: { command: "bun serve.mjs", cwd: devDir },
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
        const url = new URL(request.url, "http://fixture");
        if (url.pathname === "/api/ping") {
          return yield* HttpServerResponse.json({ pong: true });
        }
        if (url.pathname === "/api/s3") {
          const key = url.searchParams.get("key") ?? "current";
          const put = url.searchParams.get("put");
          if (put !== null) {
            yield* putObject({ Key: key, Body: put }).pipe(Effect.orDie);
          }
          const object = yield* getObject({ Key: key }).pipe(Effect.orDie);
          const value =
            object.Body === undefined
              ? undefined
              : yield* Stream.mkString(Stream.decodeText(object.Body!)).pipe(
                  Effect.orDie,
                );
          return yield* HttpServerResponse.json({ value });
        }
        return yield* HttpServerResponse.json(
          { error: "unknown api route" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
