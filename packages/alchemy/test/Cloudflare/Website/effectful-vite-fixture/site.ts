// Narrow subpath imports (DESIGN §6.1 bundle hygiene): the site module is
// re-imported inside workerd — in dev through the vite module runner, which
// evaluates every module in the graph without tree-shaking. The provider
// barrel (`alchemy/Cloudflare`) drags the whole IaC engine (bundlers, local
// runtimes, AWS credential chains) into that graph; the service-level
// subpaths keep it to the runtime slice.
import * as KV from "alchemy/Cloudflare/KV";
import * as Website from "alchemy/Cloudflare/Website";
import { passthrough } from "alchemy/serve";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * KV namespace bound by the effectful Website's program. Registered on the
 * stack when the site's init Effect runs at plan time.
 */
export const Users = KV.Namespace("EffectfulViteUsers");

/**
 * The flagship wrapper-delivery shape (DESIGN §6.2a): a Vite SPA whose
 * Effect program owns `/api/*` through the generated
 * `virtual:alchemy:website-entry` worker. Exercises, over real HTTP:
 *
 * - the KV capability binding collected at plan and served at runtime;
 * - the passthrough protocol (`/api/passthrough` falls through to the
 *   static asset layer, which answers with the SPA shell);
 * - the SPA shell and client assets outside `server.routes`.
 *
 * `main: import.meta.url` anchors this module: the engine imports it for
 * plan-time binding collection and the generated wrapper re-imports it by
 * absolute path inside workerd.
 */
export default class EffectfulViteSite extends Website.Vite<EffectfulViteSite>()(
  "EffectfulViteSite",
  {
    main: import.meta.url,
    rootDir: import.meta.dirname,
    workersDev: true,
    assets: { notFoundHandling: "single-page-application" },
    memo: {
      include: [
        "index.html",
        "package.json",
        "site.ts",
        "src/**",
        "vite.config.ts",
      ],
    },
    dev: { port: 0 },
  },
  Effect.gen(function* () {
    const namespace = yield* Users;
    const users = yield* KV.ReadWriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/api/kv") {
          const key = url.searchParams.get("key") ?? "default";
          if (request.method === "PUT") {
            const body = yield* request.text;
            yield* users.put(key, body).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ ok: true });
          }
          const value = yield* users.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }
        if (url.pathname === "/api/passthrough") {
          // Typed "not mine": delegates to the framework/asset fallback.
          return yield* passthrough;
        }
        return yield* HttpServerResponse.json({
          marker: "effect-fetch",
          path: url.pathname,
        });
      }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
