// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is bundled into the Worker (and evaluated by the vite module
// runner in dev). The provider barrel would drag the entire IaC engine into
// that graph — the service-level subpaths keep it to the construct +
// capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { SvelteKit } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";

/**
 * KV namespace bound by the site's Effect program. Registered on the stack
 * when the program's init Effect runs at plan time — no separate wiring in
 * alchemy.run.ts needed.
 */
export const Visits = KV.Namespace("Visits");

/**
 * ONE Worker serves the SvelteKit app AND a typed backend API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose RPC METHODS are the API surface. `createClient` calls them — over
 * `POST /api/__rpc/<method>` from the browser (type-only form) and by
 * direct in-process dispatch from `+page.server.ts` load functions (value
 * form). Capability bindings the program uses (the KV namespace here) are
 * collected automatically at plan time.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated Worker shim re-imports it
 * at runtime.
 */
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
  {
    main: import.meta.url,
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
      bump: () =>
        Effect.gen(function* () {
          const count = Number((yield* visits.get("count")) ?? "0") + 1;
          yield* visits.put("count", String(count));
          return count;
        }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
