// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is prebundled into the Worker next to the OpenNext artifact
// and re-evaluated inside workerd. The provider barrel would drag the
// entire IaC engine into that graph — the service-level subpaths keep it to
// the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { Nextjs } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";

/**
 * KV namespace bound by the site's Effect program. Registered on the stack
 * when the program's init Effect runs at plan time — no separate wiring in
 * alchemy.run.ts needed.
 */
export const Visits = KV.Namespace("Visits");

/**
 * ONE Worker serves the Next.js app AND a typed backend API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose RPC METHODS are the API surface. `createClient` calls them — over
 * `POST /api/__rpc/<method>` from client components (type-only form) and
 * by direct in-process dispatch from server components (value form). The
 * takeover is automatic — alchemy wraps the OpenNext worker artifact with
 * a generated entry that serves the RPC dispatch first; every other path
 * (including Next's own /api/hello route handler) stays Next's.
 *
 * The KV capability the program uses is collected automatically at plan
 * time — no separate backend worker, service binding, proxy route, or env
 * shim.
 *
 * Dev caveat: the default `alchemy dev` mode (`preview`) serves the real
 * takeover artifact with full parity. `nextjs: { devMode: "hmr" }` runs
 * `next dev` in Node, where the takeover doesn't exist — there the RPC
 * dispatch needs the explicit `alchemy/serve/next` route-handler mount.
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
        "src/backend.ts",
        "tsconfig.json",
      ],
    },
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects the KV binding) and
    // again inside the Worker on first request (builds the runtime client).
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    return {
      // RPC methods — the KV-backed visit counter. Served to `createClient`
      // at the universal `POST /api/__rpc/<method>` dispatch, and invoked
      // directly (no HTTP) by the value form in server components.
      visits: () =>
        Effect.gen(function* () {
          return Number((yield* visits.get("count")) ?? "0");
        }).pipe(Effect.orDie),
      visit: () =>
        Effect.gen(function* () {
          const count = Number((yield* visits.get("count")) ?? "0") + 1;
          yield* visits.put("count", String(count));
          return count;
        }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
