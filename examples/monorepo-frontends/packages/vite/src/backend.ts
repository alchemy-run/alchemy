// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The SPA has no framework server — the
// Effect program IS the server Lambda, and the edge routes `/api/*` to it
// ahead of the static assets (so there is no mount file in this package;
// the plain effect entry dispatches the fetch handler directly).
//
// `rootDir` is relative to the directory `alchemy` runs from (the
// monorepo root, where alchemy.run.ts lives) — the nested-package shape
// this example exists to pin.
//
// Narrow subpath imports only (`alchemy/AWS/Website`, not `alchemy/AWS`):
// this module is compiled into the Lambda — the provider barrel would
// drag the whole IaC engine along with it.
import { Vite } from "alchemy/AWS/Website";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Marker served by the effect fetch — asserted by dev and integ tests. */
export const MARKER = "monorepo-vite-effect";

/**
 * A Vite SPA fronted by CloudFront with the Effect program deployed as
 * the `/api/*` Lambda behind the same distribution.
 */
export default class Site extends Vite<Site>()(
  "Vite",
  {
    main: import.meta.url,
    rootDir: "packages/vite",
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
