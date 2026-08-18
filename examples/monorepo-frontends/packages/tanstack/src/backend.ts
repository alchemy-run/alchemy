// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time and the
// deployed Lambda re-imports it inside the TanStack Start server bundle
// to serve the effect-owned routes.
//
// `rootDir` is relative to the directory `alchemy` runs from (the
// monorepo root, where alchemy.run.ts lives) — the nested-package shape
// this example exists to pin.
//
// Narrow subpath imports only (`alchemy/AWS/Website`, not `alchemy/AWS`):
// this module is compiled into the framework server bundle — the provider
// barrel would drag the whole IaC engine along with it.
import { Vite } from "alchemy/AWS/Website";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Marker served by the effect fetch — asserted by dev and integ tests. */
export const MARKER = "monorepo-tanstack-effect";

/**
 * One Lambda serves the TanStack Start app AND the Effect program.
 * `/api/marker` below is served by the Effect program — the src/server.ts
 * mount (TanStack Start's own server-entry convention) routes `/api/*`
 * here ahead of Start's own routing.
 */
export default class Site extends Vite<Site>()(
  "TanStack",
  {
    // The SSR arm: TanStack Start's server build deploys as the Lambda
    // (with the src/server.ts mount inside); dist/client ships as assets.
    ssr: true,
    main: import.meta.url,
    rootDir: "packages/tanstack",
    forceDestroy: true,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` is path-shaped inside the effect fetch; the base
        // makes the parse total either way.
        const url = new URL(request.url, "http://site");
        if (url.pathname === "/api/marker") {
          return yield* HttpServerResponse.json({ marker: MARKER });
        }
        // Unknown path INSIDE the claim: the effect fetch is
        // authoritative here, so this renders as its OWN 404 — never
        // delegation to the framework.
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }),
) {}
