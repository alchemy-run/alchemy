import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as pathe from "pathe";

/**
 * The effectful StaticSite fixture (DESIGN §6.2b, last paragraph): the
 * compiled Effect program IS the worker in front of the assets — the
 * existing rolldown effect pipeline, with the `server.routes` →
 * `assets.runWorkerFirst` compile keeping `/api/*` reachable under SPA
 * fallback.
 *
 * The static sources are checked in under `effect-static-site/src/` and the
 * build copies them into the gitignored `dist/` (`Command.Build`'s delete
 * removes the outdir on destroy, so the outdir must be produced, never
 * checked in). Everything is deterministic — no cloning, no mutable module
 * state, safe to share between the local and live suites (each deploys it
 * into its own stack).
 *
 * This module is evaluated in two worlds: the engine (plan — bindings
 * collect, the Build runs) and workerd (the bundle's virtual entry imports
 * the default export and the worker bridge re-runs the program). Path
 * resolution is plan-only and guarded accordingly.
 */

/**
 * KV namespace bound by the impl. Exported so tests can assert its
 * identity out of band (`dev:`-prefixed locally, a real id live).
 */
export const SiteData = Cloudflare.KV.Namespace("EffectStaticSiteKV");

/**
 * Durable Object export — proves entry-level class exports ride the same
 * virtual-entry emission as a plain effect worker (the `exports` seam that
 * also carries Workflow classes).
 */
export class SiteCounter extends Cloudflare.DurableObject<SiteCounter>()(
  "EffectStaticSiteCounter",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      // Per-instance state: two sequential calls against the same DO name
      // observe 1 then 2 — a real DO roundtrip, not a stateless echo.
      let count = 0;
      return {
        increment: () => Effect.sync(() => ++count),
      };
    });
  }),
) {}

// Plan-only: inside workerd the branch folds to "" (the bundle defines
// `__ALCHEMY_RUNTIME__` to true) and `cwd` is inert data.
const fixtureDir = globalThis.__ALCHEMY_RUNTIME__
  ? ""
  : pathe.resolve(import.meta.dirname, "effect-static-site");

export default class EffectStaticSite extends Cloudflare.Website.StaticSite<EffectStaticSite>()(
  "EffectStaticSite",
  {
    // Deterministic copy build: `src/` is checked in, `dist/` is
    // gitignored (and removed by the Build resource's delete on destroy).
    command: "bash build.sh",
    shell: true,
    cwd: fixtureDir,
    outdir: "dist",
    main: import.meta.url,
    workersDev: true,
    assets: { notFoundHandling: "single-page-application" },
    // No explicit `server` prop: the default routes (["/api/*"]) must be
    // force-compiled into `runWorkerFirst` for the handlers to be
    // reachable under SPA fallback.
  },
  Effect.gen(function* () {
    const namespace = yield* SiteData;
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    const counters = yield* SiteCounter;
    return {
      // Non-fetch method: the universal RPC surface at
      // `POST /api/__rpc/stamp`, dispatched before the fetch handler.
      stamp: () => Effect.succeed({ marker: "effect-static-rpc" }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` is path-shaped inside the effect fetch; the base
        // makes the parse total either way.
        const url = new URL(request.url, "http://fixture");
        if (url.pathname === "/api/kv") {
          const key = url.searchParams.get("key") ?? "current";
          const put = url.searchParams.get("put");
          if (put !== null) {
            yield* kv.put(key, put).pipe(Effect.orDie);
          }
          const value = yield* kv.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }
        if (url.pathname === "/api/counter") {
          const count = yield* counters
            .getByName("effect-static-site")
            .increment()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ count });
        }
        return yield* HttpServerResponse.json(
          { error: "unknown api route" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
