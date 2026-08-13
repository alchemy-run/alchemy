// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is re-imported by the generated nitro entry wrapper on deploy
// and by the dev middleware inside nitro's dev worker thread. The provider
// barrel would drag the entire IaC engine into that graph — the
// service-level subpaths keep it to the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { Nuxt } from "alchemy/Cloudflare/Website";
import { passthrough } from "alchemy/serve";
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
 * ONE Worker serves the Nuxt app AND an Effect-native API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose `fetch` owns `/api/*` (the default `server.routes`). Capability
 * bindings the program uses (the KV namespace here) are collected
 * automatically at plan time.
 *
 * Routes the program doesn't claim fall through to nitro — the app's own
 * `/api/hello` route keeps working via the typed `passthrough`.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated entry re-imports it at
 * runtime.
 */
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
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
        // Typed "not mine": nitro's own routes (e.g. /api/hello) answer.
        return yield* passthrough;
      }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
