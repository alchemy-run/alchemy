// Narrow package-subpath imports, deliberately NOT the `alchemy/Cloudflare`
// barrel: the mount route file (`app/api/[[...slug]]/route.ts`, written
// into each test's clone) imports this module, so Next's bundler compiles
// the whole graph — and the provider barrel drags the IaC engine
// (bundlers, vite/esbuild, local workerd host) into it, which Turbopack
// cannot parse (native binaries) and workerd must never evaluate. The
// service-level subpaths keep the graph to the construct + capability
// slice.
import * as KV from "alchemy/Cloudflare/KV";
import { cron, CronEventSourceLive } from "alchemy/Cloudflare/Cron";
import {
  DurableObject,
  DurableObjectState,
} from "alchemy/Cloudflare/DurableObject";
import * as Website from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodePath from "node:path";

/**
 * KV namespace bound by the effectful Website's program. Registered on the
 * stack when the site's init Effect runs at plan time.
 */
export const EffectUsers = KV.Namespace("NextjsEffectUsers");

/**
 * Durable Object exported by the effect program — proves the artifact
 * takeover delivers non-fetch entry exports (the generated wrapper emits a
 * `DurableObjectBridge` class next to the OpenNext worker's own classes).
 */
export class EffectCounter extends DurableObject<EffectCounter>()(
  "EffectCounter",
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      return {
        increment: Effect.fn(function* () {
          const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
          yield* state.storage.put("count", next);
          return next;
        }),
        current: Effect.fn(function* () {
          return (yield* state.storage.get<number>("count")) ?? 0;
        }),
      };
    });
  }),
) {}

/**
 * The effectful Next.js Website (Serve/DESIGN.md, OpenNext artifact
 * takeover): ONE Worker serves the OpenNext app and the Effect program.
 * HTTP composition is the USER'S mount — an optional catch-all route file
 * (`app/api/[[...slug]]/route.ts`, written into each test's clone) calling
 * `mount(Site, { routes: ["/api/*", "!/api/hello"] })` — compiled by Next
 * like any route handler: inside the claim the program answers
 * `/api/effect/*` and renders its OWN 404 for anything else; `/api/hello`
 * stays a Next route handler because the mount's exclusion glob routes it
 * to the framework (Next also prefers the more-specific route file).
 *
 * Non-fetch surface: a Durable Object export ({@link EffectCounter}) and a
 * cron `scheduled` handler that stamps a KV key each fire — both delivered
 * by the generated `alchemy-worker.js` wrapper (additive-only: it never
 * touches HTTP), impossible on a route-file seam.
 *
 * `main: import.meta.url` anchors this module: the engine imports it for
 * plan-time binding collection and the takeover prebundle re-imports it by
 * absolute path inside workerd. `import.meta.url` is undefined when the
 * bundled module re-evaluates inside workerd — every path-derived prop
 * guards on it (they are plan-only inputs).
 */
export default class NextjsEffectSite extends Website.Nextjs<NextjsEffectSite>()(
  "NextjsEffectSite",
  {
    main: import.meta.url,
    // Plan-only (undefined when the bundled module re-evaluates in workerd,
    // where import.meta has no path). NOT `new URL(..., import.meta.url)` —
    // turbopack statically resolves that pattern as an asset reference.
    rootDir: import.meta.dirname
      ? NodePath.dirname(import.meta.dirname)
      : undefined,
    workersDev: true,
    // The route claim lives in the mount (the test-injected catch-all
    // route file): the effect fetch owns `/api/*` EXCEPT `/api/hello`,
    // which stays the OpenNext handler's (route handler + middleware).
    dev: { port: 0 },
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
    const namespace = yield* EffectUsers;
    const users = yield* KV.ReadWriteNamespace(namespace);
    const counters = yield* EffectCounter;

    // Non-fetch handler: each cron fire increments a dedicated DO counter
    // the live test polls through `/api/effect/cron`. A Durable Object
    // (strongly consistent) rather than KV (eventually consistent, reads
    // may lag up to a minute across isolates) — same pattern as the
    // CronEventSource fixture.
    yield* cron("* * * * *", () => counters.getByName("cron").increment());

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
        if (url.pathname === "/api/effect/count") {
          const next = yield* counters.getByName("default").increment();
          return yield* HttpServerResponse.json({ count: next });
        }
        if (url.pathname === "/api/effect/cron") {
          const fires = yield* counters.getByName("cron").current();
          return yield* HttpServerResponse.json({ fires });
        }
        // The HttpRouter-miss shape: renders as the effect's OWN empty
        // 404 — inside the claim the effect fetch is authoritative
        // (delegation to OpenNext happens only via the exclusion glob).
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }).pipe(
    Effect.provide(KV.ReadWriteNamespaceBinding),
    Effect.provide(CronEventSourceLive),
  ),
) {}
