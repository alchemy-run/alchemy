import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { fileURLToPath } from "node:url";
import { Users } from "./users.ts";

export { Users };

export const BINDING_MARKER = "sveltekit-effect-binding-marker";

/**
 * Project root, derived from this module's location so the fixture works
 * from a temp clone. Guarded: inside the deployed worker bundle
 * `import.meta.url` is not a resolvable `file://` URL and `new URL`
 * throws — `rootDir` is a plan-only prop, unused at runtime.
 */
const rootDir = (() => {
  try {
    return fileURLToPath(new URL("..", import.meta.url));
  } catch {
    return ".";
  }
})();

/**
 * The effectful SvelteKit Website (DESIGN §6.2b): ONE worker serving the
 * kit app AND an Effect-native API. The Effect fetch owns `/api/*` MINUS
 * the `!/api/ping` exclusion glob (strict route ownership — delegation is
 * purely a `server.routes` decision):
 *
 * - `/api/effect/kv?key=k` — GET/PUT round-trip through the KV capability
 *   binding collected at plan time.
 * - `/api/effect/uuid` — a *cacheable* response that must NEVER be served
 *   from the shim's pragma cache (effect dispatch happens before the
 *   cache lookup), pinned by asserting two requests differ.
 * - `/api/ping` — carved back out to kit by the exclusion glob; the
 *   fixture's +server endpoint serves it.
 * - any other path inside the claim fails `RouteNotFound` — rendered as
 *   the effect's OWN empty 404, never delegation to kit.
 *
 * `rootDir` is derived from this module's location so the fixture works
 * from a temp clone.
 */
export default class SvelteKitEffectSite extends Cloudflare.Website.SvelteKit<SvelteKitEffectSite>()(
  "SvelteKitEffectSite",
  {
    main: import.meta.url,
    rootDir,
    workersDev: { enabled: true, previewsEnabled: true },
    // Strict route ownership: the effect fetch owns `/api/*` EXCEPT
    // `/api/ping`, which the exclusion glob routes to kit's own handler.
    server: { routes: ["/api/*", "!/api/ping"] },
    dev: { port: 0 },
    memo: { include: ["src/**", "package.json"] },
    env: {
      TEST_BINDING: BINDING_MARKER,
    },
  },
  Effect.gen(function* () {
    const namespace = yield* Users;
    const users = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    return {
      stamp: () => Effect.succeed({ marker: "sveltekit-effect-rpc" }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `HttpServerRequest.url` is the path (+ query), not a full URL.
        const url = new URL(request.url, "http://sveltekit-effect");
        if (url.pathname === "/api/effect/kv") {
          const key = url.searchParams.get("key") ?? "greeting";
          if (request.method === "PUT") {
            const body = yield* request.text;
            yield* users.put(key, body).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ ok: true, key });
          }
          const value = yield* users.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ key, value });
        }
        if (url.pathname === "/api/effect/uuid") {
          const id = yield* Effect.sync(() => crypto.randomUUID());
          return yield* HttpServerResponse.json(
            { id },
            { headers: { "cache-control": "public, max-age=60" } },
          );
        }
        // The HttpRouter-miss shape: renders as the effect's OWN empty
        // 404 — inside the claim the effect fetch is authoritative.
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
