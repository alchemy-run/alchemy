// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is bundled into the Worker (and evaluated by the vite module
// runner in dev). The provider barrel would drag the entire IaC engine into
// that graph — the service-level subpaths keep it to the construct +
// capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { SvelteKit } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * KV namespace bound by the site's Effect program. Registered on the stack
 * when the program's init Effect runs at plan time — no separate wiring in
 * alchemy.run.ts needed.
 */
export const Visits = KV.Namespace("Visits");

/**
 * ONE Worker serves the SvelteKit app AND an Effect-native API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose `fetch` owns `/api/*` (the default `server.routes`) — inside
 * that space the program is authoritative (even its 404s); outside it
 * SvelteKit serves and the program is never invoked. Capability bindings
 * the program uses (the KV namespace here) are collected automatically
 * at plan time.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated Worker shim re-imports it
 * at runtime.
 */
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
  {
    main: import.meta.url,
    env: {
      GREETING: "Hello from alchemy",
    },
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects the KV binding) and
    // again inside the Worker on first request (builds the runtime client).
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://site");
        if (url.pathname === "/api/visits") {
          const count =
            Number((yield* visits.get("count").pipe(Effect.orDie)) ?? "0") + 1;
          yield* visits.put("count", String(count)).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ visits: count });
        }
        // The program owns everything inside `server.routes`, so unknown
        // /api/* paths get its own 404 — never SvelteKit. To hand a path
        // back to kit, exclude it: routes: ["/api/*", "!/api/foo"].
        return yield* HttpServerResponse.json(
          { error: "unknown effect route" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
