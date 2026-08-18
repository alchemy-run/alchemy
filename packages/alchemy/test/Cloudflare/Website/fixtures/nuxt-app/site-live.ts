import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * KV namespace bound by the effectful Nuxt site's program (live suite).
 */
export const LiveKv = Cloudflare.KV.Namespace("NuxtEffectLiveKv");

/**
 * SQLite-backed Durable Object owned by the effect program. Its class
 * export is collected at plan (`props.exports`) and emitted by the
 * generated nitro entry wrapper — proof the full non-fetch export surface
 * rides the entry takeover.
 */
export class EffectCounter extends Cloudflare.DurableObject<EffectCounter>()(
  "EffectCounter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      return {
        increment: Effect.fn(function* () {
          const current =
            ((yield* state.storage.get<number>("count")) ?? 0) + 1;
          yield* state.storage.put("count", current);
          return current;
        }),
        current: Effect.fn(function* () {
          return (yield* state.storage.get<number>("count")) ?? 0;
        }),
      };
    });
  }),
) {}

/**
 * The effectful Nuxt Website (Serve/DESIGN.md), live flavor: one deployed
 * Worker serving Nuxt SSR + assets AND the effect program. HTTP
 * composition is the USER'S mount — a `server/middleware/*.ts` nitro
 * middleware (written into the test's clone) calling
 * `mount(Site, { routes: ["/api/*", "!/api/hello"] })`, compiled by nitro
 * into the server bundle. The alchemy-generated nitro entry wrapper is
 * additive-only: nitro's fetch (mount inside) serves ALL HTTP verbatim,
 * and the wrapper contributes the non-fetch surface:
 *
 * - a Durable Object export (`EffectCounter`) — the wrapper emits the
 *   bridge class next to the default handler;
 * - a cron trigger — the `crons` binding collected at plan lands in the
 *   uploaded Worker metadata, and the scheduled dispatch rides the
 *   underlying Worker bridge.
 */
export default class NuxtEffectLiveSite extends Cloudflare.Website.Nuxt<NuxtEffectLiveSite>()(
  "NuxtEffectLiveSite",
  {
    main: import.meta.url,
    rootDir: import.meta.dirname,
    workersDev: { enabled: true, previewsEnabled: true },
    memo: {
      include: [
        "app/**",
        "server/**",
        "public/**",
        "nuxt.config.ts",
        "site-live.ts",
        "package.json",
      ],
    },
  },
  Effect.gen(function* () {
    const namespace = yield* LiveKv;
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    const counters = yield* EffectCounter;

    // Cron trigger: collected as a `crons` binding at plan (visible in the
    // uploaded Worker metadata); the scheduled event dispatches to this
    // handler through the wrapper's Worker-bridge dispatch.
    yield* Cloudflare.Workers.cron("*/5 * * * *", (controller) =>
      kv.put("last-cron", String(controller.scheduledTime)).pipe(Effect.orDie),
    );

    return {
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
        if (url.pathname === "/api/effect/counter") {
          const counter = counters.getByName("default");
          const count =
            request.method === "POST"
              ? yield* counter.increment()
              : yield* counter.current();
          return yield* HttpServerResponse.json({ count });
        }
        // The HttpRouter-miss shape: renders as the effect's OWN empty
        // 404 — inside the claim the effect fetch is authoritative
        // (delegation to nitro happens only via the exclusion glob).
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
  ),
) {}
