import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import ViteSite from "./fixtures/vite-site.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

/**
 * Plan-level coverage for the effectful Website constructs (collect-only
 * mode): the impl runs at plan time in the engine process — bindings
 * collect, `server.routes` compiles into `assets.runWorkerFirst`, and the
 * resolved props are stamped with `runtimeDelivery` — without any build
 * or cloud call. Nothing in this file deploys.
 */

const nodeOf = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource?.LogicalId === logicalId,
  );

const flatBindings = (node: any): any[] =>
  (node?.bindings ?? []).flatMap((b: any) => b.data?.bindings ?? []);

/** The defect of a died plan, if any. */
const defectOf = (exit: Exit.Exit<any, any>): any => {
  if (!Exit.isFailure(exit)) return undefined;
  const die = exit.cause.reasons.find(Cause.isDieReason);
  return die?.defect;
};

const okFetch = {
  fetch: Effect.succeed(HttpServerResponse.text("ok")),
};

describe.concurrent("effectful Website plan (collect-only)", () => {
  test.provider(
    "class form: stamps wrapper delivery, compiles default routes, collects KV binding",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* ViteSite;
          }),
        );

        const site = nodeOf(plan, "ViteSite");
        expect(site).toBeDefined();
        expect(site.action).toBe("create");

        // Collect-only stamp: the vite pipeline is alchemy-owned, so the
        // default tier is the auto-inject wrapper.
        expect(site.props.runtimeDelivery).toBe("wrapper");
        // The framework source is untouched — no effect bundling props.
        expect(site.props.vite).toBeDefined();
        expect(typeof site.props.main).toBe("string");
        expect(site.props.isExternal).toBeUndefined();

        // SPA + impl with fetch: the default server.routes are compiled
        // into worker-first rules (without them the asset layer would
        // answer every miss with index.html and the handlers would be
        // dead code).
        expect(site.props.assets).toMatchObject({
          notFoundHandling: "single-page-application",
          // The default "/api/*" claim already covers the universal
          // "/api/__rpc*" rpc claim, so no extra rule is appended
          // (Cloudflare's run_worker_first parser rejects redundant rules).
          runWorkerFirst: ["/api/*"],
        });

        // The impl's init ran at plan time: the KV capability collected a
        // native binding row on the Worker.
        const bindings = flatBindings(site);
        expect(bindings.some((b: any) => b.type === "kv_namespace")).toBe(true);

        // ... and the bound namespace resource itself is planned.
        const users = nodeOf(plan, "EffectfulPlanUsers");
        expect(users).toBeDefined();
        expect(users.action).toBe("create");
      }),
  );

  test.provider(
    "exclusion globs stay OUT of runWorkerFirst (assets-first-then-worker)",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Vite(
              "ExclusionRoutes",
              {
                main: import.meta.url,
                server: { routes: ["/api/*", "!/api/excluded"] },
              },
              Effect.succeed(okFetch),
            );
          }),
        );
        // A `!`-excluded path must not become a negative run_worker_first
        // rule — Cloudflare's router sends those straight to the asset
        // worker with no user-worker fallback, so a framework SSR route
        // carved out by the exclusion could never be served. Only the
        // inclusions compile; the wrapper's route gate keeps the exclusion.
        const site = nodeOf(plan, "ExclusionRoutes");
        expect(site.props.assets.runWorkerFirst).toEqual(["/api/*"]);
      }),
  );

  test.provider(
    "plain form: user routes and rules merge into runWorkerFirst",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Vite(
              "MergedRoutes",
              {
                main: import.meta.url,
                server: { routes: ["/rpc/*"] },
                assets: { runWorkerFirst: ["/admin/*"] },
              },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "MergedRoutes");
        expect(site.props.runtimeDelivery).toBe("wrapper");
        expect(site.props.assets.runWorkerFirst).toEqual([
          "/admin/*",
          "/rpc/*",
          "/api/__rpc*",
        ]);
      }),
  );

  test.provider(
    "rpc-only impl (no fetch) still claims the universal rpc path",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Vite(
              "RpcOnlySite",
              {
                main: import.meta.url,
                assets: { notFoundHandling: "single-page-application" },
              },
              Effect.succeed({
                bump: (n: number) => Effect.succeed(n + 1),
              }),
            );
          }),
        );
        // No fetch handler → no server.routes compile — but the rpc claim
        // is unconditional (no plan-time shape sniffing beyond the served
        // shape): `POST /api/__rpc/bump` must reach the worker past the
        // SPA asset layer.
        const site = nodeOf(plan, "RpcOnlySite");
        expect(site.props.assets.runWorkerFirst).toEqual(["/api/__rpc*"]);
      }),
  );

  test.provider(
    "plain form: explicit runWorkerFirst booleans are honored",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            // `true` is the user's billing choice — kept verbatim.
            yield* Cloudflare.Website.Vite(
              "WorkerFirstTrue",
              {
                main: import.meta.url,
                assets: { runWorkerFirst: true },
              },
              Effect.succeed(okFetch),
            );
            // An explicit `false` on a fullstack (non-SPA) site is also
            // honored: non-file requests still fall through to the worker.
            yield* Cloudflare.Website.Vite(
              "WorkerFirstFalse",
              {
                main: import.meta.url,
                assets: { runWorkerFirst: false, notFoundHandling: "none" },
              },
              Effect.succeed(okFetch),
            );
          }),
        );
        expect(
          nodeOf(plan, "WorkerFirstTrue").props.assets.runWorkerFirst,
        ).toBe(true);
        expect(
          nodeOf(plan, "WorkerFirstFalse").props.assets.runWorkerFirst,
        ).toBe(false);
      }),
  );

  test.provider(
    "SPA + impl + explicit runWorkerFirst: false fails fast at plan",
    (stack) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          stack.plan(
            Effect.gen(function* () {
              yield* Cloudflare.Website.Vite(
                "DeadHandlers",
                {
                  main: import.meta.url,
                  assets: {
                    runWorkerFirst: false,
                    notFoundHandling: "single-page-application",
                  },
                },
                Effect.succeed(okFetch),
              );
            }),
          ),
        );
        const defect = defectOf(exit);
        expect(defect?._tag).toBe("WorkerServerRoutingError");
        expect(String(defect?.message)).toContain("unreachable");
      }),
  );

  test.provider("server.takeover: false stamps external delivery", (stack) =>
    Effect.gen(function* () {
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          yield* Cloudflare.Website.Vite(
            "ExplicitTier",
            {
              main: import.meta.url,
              server: { takeover: false },
            },
            Effect.succeed(okFetch),
          );
        }),
      );
      const site = nodeOf(plan, "ExplicitTier");
      expect(site.props.runtimeDelivery).toBe("external");
      // Routes still compile — the explicit mount owns the same scope.
      expect(site.props.assets.runWorkerFirst).toEqual(["/api/*"]);
    }),
  );

  test.provider("invalid server.routes fail fast at plan", (stack) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Vite(
              "BadRoutes",
              {
                main: import.meta.url,
                server: { routes: ["api/*"] },
              },
              Effect.succeed(okFetch),
            );
          }),
        ),
      );
      expect(defectOf(exit)?._tag).toBe("WorkerServerRoutingError");
    }),
  );

  test.provider("impl without a main anchor fails fast at plan", (stack) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stack.plan(
          Effect.gen(function* () {
            yield* (Cloudflare.Website.Vite as any)(
              "NoAnchor",
              {},
              Effect.succeed(okFetch),
            );
          }),
        ),
      );
      const defect = defectOf(exit);
      expect(defect?._tag).toBe("WebsiteImplAnchorError");
      expect(String(defect?.message)).toContain("main: import.meta.url");
    }),
  );

  test.provider(
    "no-impl arm is untouched: external, no stamp, no route compilation",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Vite("PlainVite", {
              assets: { notFoundHandling: "single-page-application" },
            });
          }),
        );
        const site = nodeOf(plan, "PlainVite");
        expect(site.action).toBe("create");
        expect(site.props.isExternal).toBe(true);
        expect(site.props.runtimeDelivery).toBeUndefined();
        expect(site.props.assets.runWorkerFirst).toBeUndefined();
      }),
  );

  test.provider(
    "source-provider construct (Nuxt): impl stamps wrapper and keeps the anchor",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Nuxt(
              "NuxtSite",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "NuxtSite");
        expect(site.props.runtimeDelivery).toBe("wrapper");
        expect(typeof site.props.main).toBe("string");
        expect(site.props.source?.provider).toBe(
          "@alchemy.run/frontend-frameworks/nuxt/source",
        );
        // With an impl, `main` is the program anchor — the nitro
        // custom-entry seam is NOT forwarded to the source provider.
        expect(site.props.source?.options?.main).toBeUndefined();
        // ... the effect-entry descriptor is, instead (the channel local
        // dev uses, where only the resolved config surface is visible).
        expect(site.props.source?.options?.effect?.main).toBe(site.props.main);
        expect(site.props.source?.options?.effect?.routes).toEqual(["/api/*"]);
        expect(site.props.assets.runWorkerFirst).toEqual(["/api/*"]);
      }),
  );

  test.provider(
    "source-provider construct (Astro): impl stamps wrapper and threads the effect descriptor",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Astro(
              "AstroPlanSite",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "AstroPlanSite");
        expect(site.props.runtimeDelivery).toBe("wrapper");
        expect(typeof site.props.main).toBe("string");
        expect(site.props.source?.provider).toBe(
          "@alchemy.run/frontend-frameworks/astro/source",
        );
        // The integration pre-resolves `virtual:astro:fetchable` to a
        // generated wrapper importing the program module — the descriptor
        // rides the source options (Astro's channel names it `mainPath`).
        expect(site.props.source?.options?.effect?.mainPath).toBe(
          site.props.main,
        );
        expect(site.props.source?.options?.effect?.routes).toEqual(["/api/*"]);
        // Server output is forced (astro's zero-config default is static,
        // which would prerender inside workerd without bindings).
        expect(site.props.source?.options?.astro?.output).toBe("server");
        expect(site.props.assets.runWorkerFirst).toEqual(["/api/*"]);
        // The session namespace auto-provisions alongside the site.
        expect(nodeOf(plan, "AstroPlanSiteSession")).toBeDefined();
      }),
  );

  test.provider(
    "source-provider construct (SvelteKit): impl stamps wrapper and threads the dev effect descriptor",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.SvelteKit(
              "SveltePlanSite",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "SveltePlanSite");
        expect(site.props.runtimeDelivery).toBe("wrapper");
        expect(typeof site.props.main).toBe("string");
        expect(site.props.source?.provider).toBe(
          "@alchemy.run/frontend-frameworks/sveltekit/source",
        );
        // The descriptor is the dev channel (the vite-child's DevContext
        // hardcodes an external entry); build reads SourceContext.entry.
        expect(site.props.source?.options?.effect?.main).toBe(site.props.main);
        expect(site.props.source?.options?.effect?.routes).toEqual(["/api/*"]);
        expect(site.props.assets.runWorkerFirst).toEqual(["/api/*"]);
      }),
  );

  test.provider(
    "source-provider construct (Waku): impl stamps wrapper and keeps the anchor",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Waku(
              "WakuPlanSite",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "WakuPlanSite");
        expect(site.props.runtimeDelivery).toBe("wrapper");
        expect(typeof site.props.main).toBe("string");
        expect(site.props.source?.provider).toBe(
          "@alchemy.run/frontend-frameworks/waku/source",
        );
        // With an impl, `main` is the program anchor — the waku
        // custom-entry seam is NOT forwarded to the source provider.
        expect(site.props.source?.options?.main).toBeUndefined();
        expect(site.props.assets.runWorkerFirst).toEqual(["/api/*"]);
        // Waku's server runtime needs AsyncLocalStorage — nodejs_als is
        // defaulted in, and SSG pages serve extensionless.
        expect(site.props.compatibility?.flags).toContain("nodejs_als");
        expect(site.props.assets.htmlHandling).toBe("drop-trailing-slash");
      }),
  );

  test.provider(
    "Nextjs composite: worker-first true keeps the rpc path reachable (zero variance)",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Nextjs(
              "NextRpcClaim",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "NextRpcClaim");
        expect(site.props.runtimeDelivery).toBe("wrapper");
        // OpenNext owns routing with `runWorkerFirst: true` — EVERY path
        // (the universal `/api/__rpc` included) is worker-first, so the
        // rpc claim is inherently satisfied and the boolean is kept
        // verbatim (no glob merge on `true`).
        expect(site.props.assets.runWorkerFirst).toBe(true);
      }),
  );

  test.provider(
    "Octane defaults to the explicit tier (external delivery)",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.Octane(
              "OctaneSite",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        expect(nodeOf(plan, "OctaneSite").props.runtimeDelivery).toBe(
          "external",
        );
      }),
  );

  test.provider(
    "StaticSite impl stays on the rolldown effect pipeline (no stamp, forced route compile)",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* Cloudflare.Website.StaticSite(
              "PlanStatic",
              {
                command: "true",
                outdir: "dist",
                main: import.meta.url,
                assets: { notFoundHandling: "single-page-application" },
              },
              Effect.succeed(okFetch),
            );
          }),
        );
        const site = nodeOf(plan, "PlanStatic");
        expect(site).toBeDefined();
        // No collect-only stamp: the compiled effect program IS the worker
        // (classic rolldown effect entry, which `resolveSource` would
        // reject if the stamp leaked here).
        expect(site.props.runtimeDelivery).toBeUndefined();
        expect(site.props.isExternal).toBeUndefined();
        expect(typeof site.props.main).toBe("string");
        // SPA + impl with fetch: default server.routes force-compiled into
        // worker-first rules even without an explicit `server` prop.
        expect(site.props.assets.notFoundHandling).toBe(
          "single-page-application",
        );
        expect(site.props.assets.runWorkerFirst).toEqual(["/api/*"]);
      }),
  );

  test.provider(
    "external delivery rejects Durable Object exports at plan",
    (stack) =>
      Effect.gen(function* () {
        class PlanCounter extends Cloudflare.DurableObject<PlanCounter>()(
          "PlanCounter",
          Effect.gen(function* () {
            return Effect.gen(function* () {
              return { ping: () => Effect.succeed("pong") };
            });
          }),
        ) {}
        const exit = yield* Effect.exit(
          stack.plan(
            Effect.gen(function* () {
              yield* Cloudflare.Website.Vite(
                "ExportsRejected",
                {
                  main: import.meta.url,
                  server: { takeover: false },
                },
                Effect.gen(function* () {
                  yield* PlanCounter;
                  return okFetch;
                }),
              );
            }),
          ),
        );
        const defect = defectOf(exit);
        expect(defect?._tag).toBe("WorkerExportsDeliveryError");
        expect(defect?.exports).toEqual(["PlanCounter"]);
      }),
  );
});
