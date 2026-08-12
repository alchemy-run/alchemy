import * as Cloudflare from "alchemy/Cloudflare";
import { passthrough } from "alchemy/serve";
import * as Effect from "effect/Effect";
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
 * kit app AND an Effect-native API. The Effect fetch owns `/api/*`
 * (default `server.routes`):
 *
 * - `/api/effect/kv?key=k` — GET/PUT round-trip through the KV capability
 *   binding collected at plan time.
 * - `/api/effect/uuid` — a *cacheable* response that must NEVER be served
 *   from the shim's pragma cache (effect dispatch happens before the
 *   cache lookup), pinned by asserting two requests differ.
 * - everything else under `/api/*` passes through to kit — the fixture's
 *   `/api/ping` +server endpoint keeps working through the passthrough
 *   protocol.
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
        // Not ours — delegate to kit (e.g. the /api/ping +server route).
        return yield* passthrough;
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
