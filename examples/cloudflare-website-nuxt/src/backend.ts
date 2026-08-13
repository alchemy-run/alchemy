// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is re-imported by the generated nitro entry wrapper on deploy
// and by the dev middleware inside nitro's dev worker thread. The provider
// barrel would drag the entire IaC engine into that graph — the
// service-level subpaths keep it to the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import { Nuxt } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * KV namespace bound by the site's Effect program. Registered on the stack
 * when the program's init Effect runs at plan time — no separate wiring in
 * alchemy.run.ts needed.
 */
export const Visits = KV.Namespace("Visits");

/**
 * ONE Worker serves the Nuxt app AND a typed backend API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose RPC METHODS are the API surface. `createClient` calls them — over
 * `POST /api/__rpc/<method>` from the browser (type-only form) and by
 * direct in-process dispatch during SSR (value form). Capability bindings
 * the program uses (the KV namespace here) are collected automatically at
 * plan time.
 *
 * The program also keeps a `fetch` to demonstrate `server.routes`
 * ownership: inside the claim the program is authoritative (even its
 * 404s), while the exclusion glob `!/api/hello` statically hands that path
 * back to nitro, so the app's own `/api/hello` route keeps working. (The
 * RPC dispatch at `/api/__rpc/*` needs no claim — it is checked before
 * `server.routes` on every effectful Website.)
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated entry re-imports it at
 * runtime.
 */
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  {
    main: import.meta.url,
    // The URL space the Effect fetch owns. `!/api/hello` excludes nitro's
    // own route from the claim — exclusions win, so nitro serves it;
    // every other /api/* path is answered by the program (even 404s).
    server: { routes: ["/api/*", "!/api/hello"] },
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects the KV binding) and
    // again inside the Worker on first request (builds the runtime client).
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    return {
      // The program owns everything inside `server.routes` (with
      // /api/hello excluded above), so /api/* paths get its own 404 —
      // never nitro. The real API surface is the RPC methods below.
      fetch: HttpServerResponse.json(
        { error: "unknown effect route" },
        { status: 404 },
      ),
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
