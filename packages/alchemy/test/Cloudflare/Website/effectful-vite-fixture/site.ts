// Narrow subpath imports (DESIGN §6.1 bundle hygiene): the site module is
// re-imported inside workerd — in dev through the vite module runner, which
// evaluates every module in the graph without tree-shaking. The provider
// barrel (`alchemy/Cloudflare`) drags the whole IaC engine (bundlers, local
// runtimes, AWS credential chains) into that graph; the service-level
// subpaths keep it to the runtime slice.
import * as KV from "alchemy/Cloudflare/KV";
import * as Website from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
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
 * - strict route ownership: the `!/api/excluded` exclusion glob carves
 *   that path back out to the static asset layer (SPA shell), while
 *   `/api/missing` fails `RouteNotFound` — rendered as the effect's OWN
 *   empty 404, never delegation;
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
    // Strict route ownership: the effect fetch owns `/api/*` EXCEPT
    // `/api/excluded`, which the exclusion glob routes to the framework
    // (here: the SPA asset layer).
    server: { routes: ["/api/*", "!/api/excluded"] },
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
        if (url.pathname === "/api/missing") {
          // The HttpRouter-miss shape: renders as the effect's OWN empty
          // 404 through the standard pipeline — never delegation.
          return yield* Effect.fail(new RouteNotFound({ request }));
        }
        return yield* HttpServerResponse.json({
          marker: "effect-fetch",
          path: url.pathname,
        });
      }),
      // RPC methods, served to `createClient` at the universal
      // `POST /api/__rpc/<method>` dispatch (checked BEFORE
      // `server.routes`). `bumpStored` proves capability bindings work
      // inside RPC method bodies too.
      bump: (n: number) => Effect.succeed(n + 1),
      bumpStored: (key: string) =>
        Effect.gen(function* () {
          const current = yield* users.get(key).pipe(Effect.orDie);
          const next = (current === undefined ? 0 : Number(current)) + 1;
          yield* users.put(key, String(next)).pipe(Effect.orDie);
          return next;
        }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
