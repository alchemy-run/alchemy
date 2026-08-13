// Narrow subpath imports (DESIGN §6.1 bundle hygiene): this module is
// re-imported inside the framework-built server bundle (`ssr.noExternal`
// bundles everything it reaches) and inside Astro's Node dev server. The
// service-level subpaths keep the graph to the construct + capability
// slice.
import * as DynamoDB from "alchemy/AWS/DynamoDB";
import { Astro } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * DynamoDB table bound by the effectful Website's program. Registered on
 * the stack when the site's init Effect runs at plan time; tests import it
 * (from their clone of this fixture) to resolve the same row and verify
 * the binding roundtrip out of band via distilled.
 *
 * Pinned `Alchemy.remote()` so the table is REAL even under `alchemy dev`:
 * the serve shell's capability clients resolve ambient credentials
 * (`Credentials.fromChain()`) against the real AWS endpoint — the
 * SDK-backed dev model for effectful Websites (capability resources are
 * typically `remote()` in dev) — and the pin also exercises the
 * stamped-live delete path on destroy.
 */
export const Visits = DynamoDB.Table("AstroEffectVisits", {
  partitionKey: "pk",
  attributes: { pk: "S" },
}).pipe(remote());

/**
 * The Astro fetchable-wrapper delivery shape on AWS (DESIGN §6.2c,
 * §7-AWS): one Lambda serves the Astro frontend AND the Effect program's
 * API. The AWS deploy target pre-resolves `virtual:astro:fetchable` to a
 * generated wrapper importing this module by absolute path — the effect
 * fetch owns `server.routes` (via the AWS serve shell,
 * `makeWebsiteHandlers`); Astro's own pipeline serves every path outside
 * them. Exercises:
 *
 * - the DynamoDB capability bindings collected at plan (table-name env
 *   var + IAM onto the server Lambda) and served at runtime;
 * - strict route ownership (`/api/astro-echo` is a real Astro endpoint
 *   carved out of the claim by the `!/api/astro-echo` exclusion glob, so
 *   Astro serves it; an unknown path INSIDE the claim renders as the
 *   effect fetch's own 404, never delegation);
 * - SSR pages and static assets outside `server.routes`;
 * - the prerender guard (`about.astro` prerenders at build time in the
 *   prerender environment, which never loads the effect wrapper).
 *
 * `main: import.meta.url` anchors this module: the engine imports it for
 * plan-time binding collection and the generated fetchable wrapper
 * re-imports it inside the Astro `ssr` graph (and the Node dev server).
 * Tests clone the fixture and dynamically import the clone's copy, so
 * concurrent suites never share a build directory.
 */
export default class AstroEffectSite extends Astro<AstroEffectSite>()(
  "AstroEffectSite",
  {
    rootDir: import.meta.dirname,
    main: import.meta.url,
    // The effect fetch owns /api/* EXCEPT /api/astro-echo — the exclusion
    // glob carves Astro's own endpoint out of the claim (strict route
    // ownership: exclusions are the only way the framework serves a path
    // inside the claimed space).
    server: { routes: ["/api/*", "!/api/astro-echo"] },
    dev: { port: 0 },
    forceDestroy: true,
    invalidation: { paths: "all", wait: true },
  },
  Effect.gen(function* () {
    const table = yield* Visits;
    const getItem = yield* DynamoDB.GetItem(table);
    const putItem = yield* DynamoDB.PutItem(table);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` is path-shaped inside the effect fetch; the base
        // makes the parse total either way.
        const url = new URL(request.url, "http://fixture");
        if (url.pathname === "/api/marker") {
          return yield* HttpServerResponse.json({
            marker: "astro-aws-effect-fetch",
            path: url.pathname,
          });
        }
        if (url.pathname === "/api/db") {
          const key = url.searchParams.get("key") ?? "current";
          const put = url.searchParams.get("put");
          // Surface the typed failure in the response body instead of a
          // bare 500 — the dev server / Lambda logs are a hop away from
          // the test output, and the error detail is the debugging
          // signal.
          const roundtrip = Effect.gen(function* () {
            if (put !== null) {
              yield* putItem({
                Item: { pk: { S: key }, value: { S: put } },
              });
            }
            const result = yield* getItem({
              Key: { pk: { S: key } },
              ConsistentRead: true,
            });
            return result.Item?.value?.S ?? null;
          });
          return yield* roundtrip.pipe(
            Effect.flatMap((value) => HttpServerResponse.json({ value })),
            Effect.catchCause((cause) =>
              HttpServerResponse.json(
                { error: Cause.pretty(cause) },
                { status: 500 },
              ),
            ),
          );
        }
        // Unknown path INSIDE the claim: the effect fetch is
        // authoritative, so this renders as its OWN 404 response (a
        // `RouteNotFound` failure is what an `HttpRouter` miss produces —
        // it flows through the standard pipeline as a 404, never
        // delegation to Astro).
        return yield* Effect.fail(
          new RouteNotFound({
            request,
            description: "astro-aws-effect 404",
          }),
        );
      }),
    };
  }).pipe(Effect.provide([DynamoDB.GetItemHttp, DynamoDB.PutItemHttp])),
) {}
