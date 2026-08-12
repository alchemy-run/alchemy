import * as Cloudflare from "alchemy/Cloudflare";
import { passthrough } from "alchemy/serve";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodePath from "node:path";

/**
 * KV namespace bound by the effectful Website's program. Registered on the
 * stack when the site's init Effect runs at plan time.
 */
export const EffectUsers = Cloudflare.KV.Namespace("NextjsEffectUsers");

/**
 * Durable Object exported by the effect program — proves the artifact
 * takeover delivers non-fetch entry exports (the generated wrapper emits a
 * `DurableObjectBridge` class next to the OpenNext worker's own classes).
 */
export class EffectCounter extends Cloudflare.DurableObject<EffectCounter>()(
  "EffectCounter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
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
 * The effectful Next.js Website (artifact takeover, DESIGN §2.1.1): ONE
 * Worker serves the OpenNext app and the Effect program. The program owns
 * `/api/*` (the default `server.routes`); inside that scope it answers
 * `/api/effect/*` and passes everything else through to the framework
 * (`/api/hello` & co stay Next route handlers).
 *
 * Non-fetch surface: a Durable Object export ({@link EffectCounter}) and a
 * cron `scheduled` handler that stamps a KV key each fire — both delivered
 * by the generated `alchemy-worker.js` wrapper, impossible on a fetch-level
 * seam.
 *
 * `main: import.meta.url` anchors this module: the engine imports it for
 * plan-time binding collection and the takeover prebundle re-imports it by
 * absolute path inside workerd. `import.meta.url` is undefined when the
 * bundled module re-evaluates inside workerd — every path-derived prop
 * guards on it (they are plan-only inputs).
 */
export default class NextjsEffectSite extends Cloudflare.Website.Nextjs<NextjsEffectSite>()(
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
    const users = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    const counters = yield* EffectCounter;

    // Non-fetch handler: each cron fire increments a dedicated DO counter
    // the live test polls through `/api/effect/cron`. A Durable Object
    // (strongly consistent) rather than KV (eventually consistent, reads
    // may lag up to a minute across isolates) — same pattern as the
    // CronEventSource fixture.
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      counters.getByName("cron").increment(),
    );

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
        // Everything else inside `/api/*` is not ours: the OpenNext handler
        // serves it (Next route handlers, middleware included).
        return yield* passthrough;
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
  ),
) {}
