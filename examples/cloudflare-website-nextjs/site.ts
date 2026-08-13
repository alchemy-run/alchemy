// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is prebundled into the Worker next to the OpenNext artifact
// and re-evaluated inside workerd. The provider barrel would drag the
// entire IaC engine into that graph — the service-level subpaths keep it to
// the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { Nextjs } from "alchemy/Cloudflare/Website";
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
 * ONE Worker serves the Next.js app AND an Effect-native API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose `fetch` owns `/api/*` (the default `server.routes`). The takeover
 * is automatic — no route.ts mount needed: alchemy wraps the OpenNext
 * worker artifact with a generated entry that dispatches the effect routes
 * first. Routes the program doesn't claim fall through to Next — the app's
 * own `/api/hello` route handler keeps working via the typed `passthrough`.
 *
 * Dev caveat: the default `alchemy dev` mode (`preview`) serves the real
 * takeover artifact with full parity. `nextjs: { devMode: "hmr" }` runs
 * `next dev` in Node, where the takeover doesn't exist — there the effect
 * fetch needs the explicit `alchemy/serve/next` route-handler mount.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated entry re-imports it at
 * runtime.
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
        "public/**",
        "package.json",
        "next.config.mjs",
        "postcss.config.mjs",
        "open-next.config.ts",
        "site.ts",
        "tsconfig.json",
      ],
    },
    env: {
      GREETING: "Hello from Alchemy!",
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
        // Typed "not mine": Next's own route handlers (e.g. /api/hello)
        // answer everything else under /api/*.
        return yield* passthrough;
      }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
