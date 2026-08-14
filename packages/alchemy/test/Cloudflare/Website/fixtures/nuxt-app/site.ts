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
 * The Nuxt effect entry takeover shape (DESIGN Amendment §2.1.2), dev
 * flavor: an effectful `Cloudflare.Website.Nuxt` whose Effect program owns
 * `/api/*`. In dev the program is mounted as an alchemy-generated nitro
 * middleware (routes-scoped `toEventHandler`) inside nitro's dev SSR
 * worker thread; the KV capability resolves through the platform proxy to
 * the local simulator. Exercises:
 *
 * - `POST /api/__rpc/greet` — the universal rpc dispatch (`createClient`
 *   wire protocol), claimed by the middleware ahead of route matching;
 * - `/api/effect/kv` — the effect fetch with the KV binding;
 * - `/api/hello` — carved out of the claim by the `!/api/hello` exclusion
 *   glob, so nitro's own scanned route answers (strict route ownership:
 *   delegation is purely a `server.routes` decision);
 * - `/` — Nuxt SSR outside the effect routes.
 *
 * `main: import.meta.url` anchors this module: the engine imports it for
 * plan-time binding collection, and the generated dev middleware (and, on
 * deploy, the generated nitro entry wrapper) re-imports it by path.
 */
export default class NuxtEffectSite extends Cloudflare.Website.Nuxt<NuxtEffectSite>()(
  "NuxtEffectSite",
  {
    main: import.meta.url,
    rootDir: import.meta.dirname,
    // Strict route ownership: the effect fetch owns `/api/*` EXCEPT
    // `/api/hello`, which the exclusion glob routes to nitro's own route.
    server: { routes: ["/api/*", "!/api/hello"] },
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
      /** RPC method (POST /api/__rpc/greet — the universal rpc dispatch). */
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
