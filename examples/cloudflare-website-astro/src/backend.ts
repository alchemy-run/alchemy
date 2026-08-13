// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is re-imported inside the Worker by the generated entry, and
// in dev the vite module runner evaluates its whole import graph. The
// provider barrel would drag the entire IaC engine into that graph — the
// service-level subpaths keep it to the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { Astro } from "alchemy/Cloudflare/Website";
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
 * ONE Worker serves the Astro frontend AND an Effect-native API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose `fetch` owns `server.routes`. Capability bindings the program uses
 * (the KV namespace here) are collected automatically at plan time.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated Worker entry re-imports it
 * at runtime.
 */
export default class Site extends Astro<Site>()(
  "Astro",
  {
    main: import.meta.url,
    // The URL space the Effect fetch owns — inside it the program is
    // authoritative (even its 404s). Everything else — SSR pages,
    // prerendered pages, static assets — is served by Astro exactly as
    // before, and the effect fetch is never invoked for it.
    server: { routes: ["/api/*"] },
    // Only hash the files that affect the build, so unchanged sources
    // skip the Astro build (and the deploy) entirely.
    memo: {
      include: [
        "src/**",
        "public/**",
        "package.json",
        "astro.config.ts",
        "src/backend.ts",
      ],
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
        // /api/* paths get its own 404 — never Astro. To hand a path back
        // to Astro, exclude it statically: routes: ["/api/*", "!/api/foo"].
        return yield* HttpServerResponse.json(
          { error: "unknown effect route" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
