import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * KV namespace bound by the effectful Nuxt site's program. Registered on
 * the stack when the site's init Effect runs at plan time.
 */
export const EffectKv = Cloudflare.KV.Namespace("NuxtEffectKv");

/**
 * The effectful Nuxt Website (Serve/DESIGN.md), dev flavor: an effectful
 * `Cloudflare.Website.Nuxt` whose Effect program owns `/api/*` through
 * the USER'S mount — a `server/middleware/*.ts` nitro middleware the test
 * writes into its clone, calling
 * `mount(Site, { routes: ["/api/*", "!/api/hello"] })` and returning
 * `site.fetch(toWebRequest(event), ...)` (undefined = nitro serves). The
 * middleware is ordinary app code nitro compiles into its dev SSR worker
 * thread; the KV capability resolves through the platform proxy to the
 * local simulator. Exercises:
 *
 * - `/api/effect/kv` — the effect fetch with the KV binding;
 * - `/api/hello` — carved out of the claim by the mount's `!/api/hello`
 *   exclusion glob, so nitro's own scanned route answers (strict route
 *   ownership: delegation is purely the mount's decision);
 * - `/` — Nuxt SSR outside the effect routes.
 *
 * `main: import.meta.url` anchors this module: the engine imports it for
 * plan-time binding collection, and the mount re-imports it by path.
 */
export default class NuxtEffectSite extends Cloudflare.Website.Nuxt<NuxtEffectSite>()(
  "NuxtEffectSite",
  {
    main: import.meta.url,
    rootDir: import.meta.dirname,
    dev: { port: 0 },
    memo: {
      include: [
        "app/**",
        "server/**",
        "public/**",
        "nuxt.config.ts",
        "site.ts",
        "package.json",
      ],
    },
  },
  Effect.gen(function* () {
    const namespace = yield* EffectKv;
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    return {
      /** RPC method (trusted callers only — no HTTP wire). */
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/api/effect/kv") {
          const key = url.searchParams.get("key") ?? "effect-key";
          if (request.method === "PUT") {
            const value = url.searchParams.get("value") ?? "";
            yield* kv.put(key, value).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ put: true, key });
          }
          const value = yield* kv.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ key, value: value ?? null });
        }
        if (url.pathname === "/api/effect/marker") {
          return yield* HttpServerResponse.json({ marker: "nuxt-effect-dev" });
        }
        // The HttpRouter-miss shape: renders as the effect's OWN empty
        // 404 — inside the claim the effect fetch is authoritative
        // (delegation to nitro happens only via the exclusion glob).
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
