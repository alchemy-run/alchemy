// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is re-imported inside the Worker by the generated entry, and
// in dev the vite module runner evaluates its whole import graph. The
// provider barrel would drag the entire IaC engine into that graph — the
// service-level subpaths keep it to the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { Astro } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";

/**
 * KV namespace bound by the site's Effect program. Registered on the stack
 * when the program's init Effect runs at plan time — no separate wiring in
 * alchemy.run.ts needed.
 */
export const Visits = KV.Namespace("Visits");

/**
 * ONE Worker serves the Astro frontend AND a typed backend API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose RPC METHODS are the API surface. `createClient` calls them — over
 * `POST /api/__rpc/<method>` from the browser (type-only form) and by
 * direct in-process dispatch from server-rendered frontmatter (value
 * form). Capability bindings the program uses (the KV namespace here) are
 * collected automatically at plan time.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated Worker entry re-imports it
 * at runtime.
 */
export default class Site extends Astro<Site>()(
  "Astro",
  {
    main: import.meta.url,
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
      // RPC methods — the KV-backed visit counter. Served to `createClient`
      // at the universal `POST /api/__rpc/<method>` dispatch, and invoked
      // directly (no HTTP) by the value form during SSR.
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
