// Narrow package-subpath imports, deliberately NOT the `alchemy/Cloudflare`
// barrel: this module is compiled by Next (turbopack) for the hmr explicit
// tier, and the provider barrels pull the local-provider chain whose import
// graph ends at the workerd native binary — unparseable by turbopack. The
// service-level subpaths resolve identically for bun (plan world) and
// turbopack (the fixture clone under `packages/alchemy/.tmp/<dir>/` walks up
// to the workspace root's `alchemy` link).
import * as KV from "alchemy/Cloudflare/KV";
import * as Website from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodePath from "node:path";

/** KV namespace bound by the hmr-mode explicit-tier program. */
export const HmrUsers = KV.Namespace("NextjsEffectHmrUsers");

/**
 * The hmr-mode (`next dev` in Node) explicit-tier site: fetch-only, served
 * through the `toRouteHandler` catch-all mount the test writes into
 * `app/api/effect/[[...slug]]/route.ts` — the documented Next.js hmr path
 * (the artifact takeover only exists in `preview` dev and deploys).
 *
 * Kept free of DO/cron surface: hmr delivery is fetch-only by design.
 */
export default class NextjsEffectHmrSite extends Website.Nextjs<NextjsEffectHmrSite>()(
  "NextjsEffectHmrSite",
  {
    main: import.meta.url,
    // Plan-only (undefined when the bundled module re-evaluates in workerd,
    // where import.meta has no path). NOT `new URL(..., import.meta.url)` —
    // turbopack statically resolves that pattern as an asset reference.
    rootDir: import.meta.dirname
      ? NodePath.dirname(import.meta.dirname)
      : undefined,
    workersDev: true,
    dev: { port: 0 },
    nextjs: { devMode: "hmr" },
    memo: {
      include: [
        "app/**",
        "pages/**",
        "public/**",
        "src/**",
        "package.json",
        "tsconfig.json",
        "middleware.ts",
        "next.config.mjs",
        "open-next.config.ts",
      ],
    },
  },
  Effect.gen(function* () {
    const namespace = yield* HmrUsers;
    const users = yield* KV.ReadWriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/api/effect/ping") {
          return yield* HttpServerResponse.json({ marker: "effect-fetch" });
        }
        if (url.pathname === "/api/effect/kv") {
          const key = url.searchParams.get("key") ?? "default";
          if (request.method === "PUT") {
            const body = yield* request.text;
            yield* users.put(key, body).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ ok: true });
          }
          const value = yield* users.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }
        // The HttpRouter-miss shape: renders as the effect's OWN empty
        // 404 (the catch-all mount has no framework to fall back to).
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
) {}
