import * as AWS from "@/AWS";
import { makeFunctionBundler } from "@/AWS/Lambda/FunctionBundle.ts";
import {
  makeEffectFrameworkSite,
  prepareServerWrapperEntry,
} from "@/AWS/Website/FrameworkSite.ts";
import { SERVE_BRIDGE_KEY } from "@/Serve/constants.ts";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// The engine's ConfigProvider (`loadConfigProvider` → `fromEnv()`)
// SNAPSHOTS `process.env` at construction — seed the plan-only config value
// at module scope, before any harness stack builds its provider. The key is
// unique to this suite, so leaving it set is inert for every other test.
process.env.EFFECTFUL_SITE_PLAN_SECRET = "site-plan-secret";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Plan-level coverage for the effectful AWS Website composites (collect-only
 * threading): the impl runs at plan time in the engine process — bindings
 * collect env vars + IAM policy statements onto the composite's server
 * Lambda, the delivery stamp threads into the collect-only props and the edge
 * `serverRoutes` compile, and the resolved Lambda props are stamped with
 * `runtimeDelivery` — without any build or cloud call. Nothing in this file
 * deploys.
 */

const mountedDist = new URL(
  "./fixtures/effectful-server/index.mjs",
  import.meta.url,
).pathname;
const unmountedDist = new URL(
  "./fixtures/effectful-server-unmounted/index.mjs",
  import.meta.url,
).pathname;

const nodeOf = (plan: any, logicalId: string, type?: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) =>
      node.resource?.LogicalId === logicalId &&
      (type === undefined || node.resource?.Type === type),
  );

/** The defect of a died plan, if any. */
const defectOf = (exit: Exit.Exit<any, any>): any => {
  if (!Exit.isFailure(exit)) return undefined;
  const die = exit.cause.reasons.find(Cause.isDieReason);
  return die?.defect;
};

/** The typed failure of a failed exit, if any. */
const failureOf = (exit: Exit.Exit<any, any>): any => {
  if (!Exit.isFailure(exit)) return undefined;
  const fail = exit.cause.reasons.find(
    (reason: any) => reason._tag === "Fail",
  ) as any;
  return fail?.error;
};

const okFetch = {
  fetch: Effect.succeed(HttpServerResponse.text("ok")),
};

describe.concurrent("effectful Website composites plan (collect-only)", () => {
  test.provider(
    "Astro impl arm: collect-only server Lambda stamps external delivery and collects the DynamoDB binding",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const table = yield* AWS.DynamoDB.Table("PlanVisits", {
              partitionKey: "pk",
              attributes: { pk: "S" },
            });
            yield* AWS.Website.Astro(
              "AstroSite",
              { main: import.meta.url },
              Effect.gen(function* () {
                const getItem = yield* AWS.DynamoDB.GetItem(table);
                void getItem;
                return okFetch;
              }).pipe(Effect.provide(AWS.DynamoDB.GetItemHttp)),
            );
          }),
        );

        // The framework build resource is planned unchanged.
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        expect(build.action).toBe("create");

        // The composite's server Lambda runs in collect-only mode: the
        // framework artifact ships as-is (`bundle: false`, `handler`
        // preserved). Astro is the auto-inject (wrapper) tier — the AWS
        // deploy target's integration pre-resolves Astro's
        // `virtual:astro:fetchable` to a generated wrapper mounting the
        // AWS serve shell, driven by the `effectOptions` build option.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.action).toBe("create");
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(server.props.bundle).toBe(false);
        expect(server.props.handler).toBe("handler");
        expect(server.props.isExternal).toBeUndefined();
        // The default routes thread into the collect-only server props
        // (the same list compiles into the edge router's serverRoutes).
        // The fetchable-wrapper inputs ride the framework build options
        // (`targetConfig.effect` -> the AWS deploy target's config).
        const buildTargetConfig = build.props.options?.targetConfig as
          | { effect?: { main?: string } }
          | undefined;
        expect(buildTargetConfig?.effect?.main).toContain(
          "EffectfulPlan.test.ts",
        );
        // Routing lives in the user's mount — no routes ride the build
        // options (Serve/DESIGN.md).
        expect(buildTargetConfig?.effect).not.toHaveProperty("routes");

        // The impl's init ran at plan time: the DynamoDB capability
        // collected an IAM policy row through the binding channel.
        const statements = (server.bindings ?? []).flatMap(
          (binding: any) => binding.data?.policyStatements ?? [],
        );
        expect(
          statements.some((statement: any) =>
            (statement.Action ?? []).includes("dynamodb:GetItem"),
          ),
        ).toBe(true);

        // ... and the table's physical name rode the env channel.
        const envKeys = Object.keys(server.props.env ?? {});
        expect(envKeys.some((key) => key.includes("tableName"))).toBe(true);

        // ... and the bound table resource itself is planned.
        expect(nodeOf(plan, "PlanVisits")).toBeDefined();
      }),
  );

  test.provider(
    "server.verify threads into the collect-only props",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Waku(
              "WakuSite",
              {
                main: import.meta.url,
                server: { verify: false },
              },
              Effect.succeed(okFetch),
            );
          }),
        );
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server.props.server).toMatchObject({ verify: false });
      }),
  );

  test.provider(
    "Waku impl arm: wrapper tier by default — single-handler delivery with effect build options",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Waku(
              "WakuDefaults",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(server.props.bundle).toBe(false);
        // The effect inputs ride the framework build options (the deploy
        // target's finishing pass generates the single-handler entry).
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        expect(build.props.options?.effect).toBeDefined();
        expect(build.props.options?.effectHash).toBeDefined();
      }),
  );

  test.provider(
    "every composite overload plans: Nuxt, Octane, SvelteKit (class form)",
    (stack) =>
      Effect.gen(function* () {
        // Plain impl arm, explicit tier (no framework-integrated wrapper).
        {
          const plan = yield* stack.plan(
            Effect.gen(function* () {
              yield* AWS.Website.Octane(
                "OctaneSite",
                { main: import.meta.url },
                Effect.succeed(okFetch),
              );
            }),
          );
          const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
          expect(server).toBeDefined();
          expect(server.props.runtimeDelivery).toBe("external");
          expect(server.props.bundle).toBe(false);
          }

        // Nuxt is the auto-inject (wrapper) tier: the framework
        // integration writes the generated effect middleware under
        // `.alchemy/nuxt/<id>/` and injects it via `nitro.handlers` in
        // both build and dev, driven by the `effect` build option (which
        // carries the construct id naming the generated dir).
        {
          const plan = yield* stack.plan(
            Effect.gen(function* () {
              yield* AWS.Website.Nuxt(
                "NuxtSite",
                { main: import.meta.url },
                Effect.succeed(okFetch),
              );
            }),
          );
          const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
          expect(server).toBeDefined();
          expect(server.props.runtimeDelivery).toBe("wrapper");
          expect(server.props.bundle).toBe(false);
          const build = nodeOf(plan, "Build", "AWS.Website.Server");
          expect(build).toBeDefined();
          const options = build.props.options as {
            effect: { id: string; main: string };
            effectHash: string;
          };
          expect(options.effect.id).toBe("NuxtSite");
          // Routing lives in the user's middleware mount — no routes ride
          // the build options; the descriptor carries the platform-surface
          // inputs only.
          expect(options.effect).not.toHaveProperty("routes");
          expect(options.effect.main).toContain("EffectfulPlan.test.ts");
          expect(typeof options.effectHash).toBe("string");
        }

        // Curried class form: the class is a real Effect and plans the
        // same collect-only server Lambda. SvelteKit is the auto-inject
        // (wrapper) tier: the deploy target's generated Lambda entry
        // composes the effect fetch itself, driven by the `effect` build
        // options on the framework build.
        class SvelteSite extends AWS.Website.SvelteKit<SvelteSite>()(
          "SvelteSite",
          { main: import.meta.url },
          Effect.succeed(okFetch),
        ) {}
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* SvelteSite;
          }),
        );
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(server.props.bundle).toBe(false);
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        const options = build.props.options as {
          effect: { main: string };
          effectHash: string;
        };
        expect(options.effect.main).toContain("EffectfulPlan.test.ts");
        // Routing lives in the user's mount — no routes ride the build
        // options (Serve/DESIGN.md).
        expect(options.effect).not.toHaveProperty("routes");
        expect(typeof options.effectHash).toBe("string");
      }),
  );

  test.provider(
    "Nextjs impl arm: wrapper stamp + derived-config effect options ride the OpenNext topology",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Nextjs(
              "NextSite",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        // Auto-inject (wrapper) tier: the framework module derives an
        // OpenNext config under `.alchemy/generated/<id>/` whose custom
        // wrapper composes the effect fetch — no user mount, so the
        // sentinel scan's missing-mount error is retired (the scan only
        // runs on external delivery).
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(server.props.bundle).toBe(false);
        // The effect inputs ride the framework build options (the derived
        // config generator consumes them in the build child), and the
        // effect module's content hash keys rebuilds.
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        const options = build.props.options as {
          effect: { id: string; main: string };
          effectHash: string;
        };
        expect(options.effect.id).toBe("NextSite");
        expect(options.effect.main).toContain("EffectfulPlan.test.ts");
        // Routing lives in the user's mount — no routes ride the build
        // options (Serve/DESIGN.md).
        expect(options.effect).not.toHaveProperty("routes");
        expect(typeof options.effectHash).toBe("string");
        // The OpenNext cache env names survive the impl threading (the
        // collected env merges INTO them, never replaces them).
        const envKeys = Object.keys(server.props.env ?? {});
        for (const key of [
          "CACHE_BUCKET_NAME",
          "CACHE_BUCKET_KEY_PREFIX",
          "REVALIDATION_QUEUE_URL",
          "CACHE_DYNAMO_TABLE",
        ]) {
          expect(envKeys).toContain(key);
        }
        // The rest of the OpenNext topology is planned unchanged.
        expect(nodeOf(plan, "RevalidationQueue")).toBeDefined();
        expect(nodeOf(plan, "TagCache")).toBeDefined();
        expect(nodeOf(plan, "ImageOptimization")).toBeDefined();
      }),
  );

  test.provider(
    "no-impl arms are untouched: external server Lambda, no stamp, no route threading",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Astro("PlainAstro", {});
          }),
        );
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.action).toBe("create");
        expect(server.props.isExternal).toBe(true);
        expect(server.props.bundle).toBe(false);
        expect(server.props.runtimeDelivery).toBeUndefined();
        expect(server.props.server).toBeUndefined();
        expect(server.props.functionUrl).toMatchObject({
          authType: "NONE",
          invokeMode: "RESPONSE_STREAM",
        });
        expect(nodeOf(plan, "Build", "AWS.Website.Server")).toBeDefined();
      }),
  );

  test.provider("impl without a main anchor fails fast at plan", (stack) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        stack.plan(
          Effect.gen(function* () {
            yield* (AWS.Website.SvelteKit as any)(
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
    "Astro static output rejects an Effect program at plan",
    (stack) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          stack.plan(
            Effect.gen(function* () {
              yield* AWS.Website.Astro(
                "StaticEffect",
                { main: import.meta.url, astro: { output: "static" } },
                Effect.succeed(okFetch),
              );
            }),
          ),
        );
        const defect = defectOf(exit);
        expect(defect?._tag).toBe("AstroEffectStaticOutputError");
        expect(String(defect?.message)).toContain("assets-only");
      }),
  );

  test.provider(
    "Vite SSR impl arm: specifier threading + wrapper tier + collected DynamoDB binding",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const table = yield* AWS.DynamoDB.Table("ViteSsrVisits", {
              partitionKey: "pk",
              attributes: { pk: "S" },
            });
            yield* AWS.Website.Vite(
              "ViteSsrSite",
              { ssr: true, main: import.meta.url },
              Effect.gen(function* () {
                const getItem = yield* AWS.DynamoDB.GetItem(table);
                void getItem;
                return okFetch;
              }).pipe(Effect.provide(AWS.DynamoDB.GetItemHttp)),
            );
          }),
        );

        // The framework build rides the generic vite integration + its AWS
        // deploy target (loaded from the PROJECT's node_modules at build
        // time — never at plan).
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        expect(build.props.framework).toBe(
          "@alchemy.run/frontend-frameworks/vite",
        );
        expect(build.props.target).toBe(
          "@alchemy.run/frontend-frameworks/vite/aws",
        );
        // Auto-inject (wrapper) tier: the deploy target's generated Lambda
        // entry composes the effect fetch, driven by the `effect` build
        // options; the effect module's content hash keys rebuilds.
        const options = build.props.options as {
          effect: { main: string };
          effectHash: string;
        };
        expect(options.effect.main).toContain("EffectfulPlan.test.ts");
        // Routing lives in the user's mount — no routes ride the build
        // options (Serve/DESIGN.md).
        expect(options.effect).not.toHaveProperty("routes");
        expect(typeof options.effectHash).toBe("string");

        // The composite's server Lambda runs in collect-only mode over the
        // framework artifact (`bundle: false`, streaming Function URL).
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(server.props.bundle).toBe(false);
        expect(server.props.handler).toBe("handler");
        expect(server.props.functionUrl).toMatchObject({
          authType: "NONE",
          invokeMode: "RESPONSE_STREAM",
        });

        // The impl's init ran at plan time: the DynamoDB capability
        // collected IAM + the table-name env var through the binding
        // channel.
        const statements = (server.bindings ?? []).flatMap(
          (binding: any) => binding.data?.policyStatements ?? [],
        );
        expect(
          statements.some((statement: any) =>
            (statement.Action ?? []).includes("dynamodb:GetItem"),
          ),
        ).toBe(true);
        const envKeys = Object.keys(server.props.env ?? {});
        expect(envKeys.some((key) => key.includes("tableName"))).toBe(true);
      }),
  );

  test.provider(
    "Vite SSR: viteEnvironments thread into the build options",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Vite(
              "ViteRscSite",
              {
                ssr: true,
                main: import.meta.url,
                viteEnvironments: { entry: "rsc", children: ["ssr"] },
              },
              Effect.succeed(okFetch),
            );
          }),
        );
        // The environment split reaches the framework integration through
        // the build options.
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build.props.options?.viteEnvironments).toEqual({
          entry: "rsc",
          children: ["ssr"],
        });
      }),
  );

  test.provider(
    "Vite SSR no-impl arm: plain framework site, no stamp, no route threading",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Vite("PlainViteSsr", { ssr: true });
          }),
        );
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        expect(build.props.framework).toBe(
          "@alchemy.run/frontend-frameworks/vite",
        );
        expect(build.props.options).toBeUndefined();
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.isExternal).toBe(true);
        expect(server.props.bundle).toBe(false);
        expect(server.props.runtimeDelivery).toBeUndefined();
        expect(server.props.server).toBeUndefined();
      }),
  );

  test.provider(
    "wrapper tier: config.wrapperEntry generates the entry, threads options.main + effectHash, stamps wrapper",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-aws-wrapper-plan-",
        });

        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* makeEffectFrameworkSite(
              "WrapperSite",
              { main: import.meta.url, rootDir: root },
              {
                name: "TestFramework",
                framework: "@alchemy.run/frontend-frameworks/nuxt",
                target: "@alchemy.run/frontend-frameworks/nuxt/aws",
                wrapperEntry: ({ mainPath, routes }) =>
                  `// generated by alchemy (test)\n` +
                  `import Site from ${JSON.stringify(mainPath)};\n` +
                  `export const routes = ${JSON.stringify(routes)};\n`,
              },
              Effect.succeed(okFetch),
            );
          }),
        );

        // The generated entry exists on disk BEFORE any build would run,
        // under the project root so the framework toolchain can bundle it.
        const entryPath = path.join(
          root,
          ".alchemy",
          "generated",
          "WrapperSite",
          "entry.mjs",
        );
        expect(yield* fs.exists(entryPath)).toBe(true);
        const entry = yield* fs.readFileString(entryPath);
        expect(entry).toContain('"/api/*"');

        // The build resource carries the wrapper path on the deploy
        // target's user-entry seam plus the effect-module content hash
        // (the memo surface that redeploys on effect edits).
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build.props.options.main).toBe(entryPath);
        expect(String(build.props.options.effectHash)).toMatch(
          /^[0-9a-f]{64}$/,
        );

        // ... and the server Lambda is stamped with the auto-inject tier.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server.props.runtimeDelivery).toBe("wrapper");

        yield* fs.remove(root, { recursive: true });
      }),
  );

});

// ─────────────────────────────────────────────────────────────────────
// Dev mode: no CDN resources; the effect program deploys as the local
// emulator sibling and the collected env map (plus the alchemy stack
// markers the in-process `alchemy/Serve` mount needs) is lowered into the
// dev `Server` resource's env — which applies it to the framework dev
// server's process environment (`Server.ts` start).
// ─────────────────────────────────────────────────────────────────────

const dev = Test.make({
  providers: AWS.providers(),
  dev: true,
  sidecar: false,
});

describe.concurrent("effectful Website composites plan (dev)", () => {
  dev.test.provider(
    "dev: collected env (and stack markers) lower into the dev Server resource",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Nuxt(
              "DevSite",
              {
                main: import.meta.url,
                server: { environment: { SITE_DEV_VAR: "dev-var" } },
              },
              Effect.gen(function* () {
                const secret = yield* Config.string(
                  "EFFECTFUL_SITE_PLAN_SECRET",
                );
                void secret;
                return okFetch;
              }),
            );
          }),
        );

        // The framework dev server resource carries the lowered env:
        // user-provided vars, the intercepted Config read (packed), and
        // the stack markers that make the in-process serve mount engage
        // (`hasStackMarkers`). `ALCHEMY_PHASE` is NOT lowered — the serve
        // bridge forces the runtime phase itself, and stamping it into the
        // sidecar's process env could confuse engine-side code.
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        const env = build.props.env ?? {};
        expect(env.SITE_DEV_VAR).toBe("dev-var");
        const envKeys = Object.keys(env);
        expect(envKeys).toContain("EFFECTFUL_SITE_PLAN_SECRET");
        expect(envKeys).toContain("ALCHEMY_STACK_NAME");
        expect(envKeys).toContain("ALCHEMY_STAGE");
        expect(env.ALCHEMY_PHASE).toBeUndefined();

        // Nuxt's wrapper-tier build options ride into the dev Server too —
        // the effect descriptor carries the platform-surface inputs (HTTP
        // is the user's server/middleware mount, compiled by nitro).
        const devOptions = build.props.options as {
          effect: { id: string; main: string };
        };
        expect(devOptions.effect.id).toBe("DevSite");
        expect(devOptions.effect.main).toContain("EffectfulPlan.test.ts");

        // The effect program deploys as its own effect-native Lambda (the
        // local emulator sibling) — normal effect pipeline, not
        // collect-only: `main` is the program anchor and there is no
        // delivery stamp.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.main).toBe(import.meta.url);
        expect(server.props.bundle).toBeUndefined();
        expect(server.props.runtimeDelivery).toBeUndefined();

        // No CDN resources are declared in dev.
        expect(nodeOf(plan, "Distribution")).toBeUndefined();
        expect(nodeOf(plan, "Bucket")).toBeUndefined();
      }),
  );

  dev.test.provider(
    "dev: SvelteKit (wrapper tier) threads the effect build options into the dev Server",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.SvelteKit(
              "DevSvelte",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        // The hooks mount owns dev HTTP (Serve/DESIGN.md); the effect
        // options only carry the anchor (the dev plugin keeps alchemy
        // external to vite's SSR transform).
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        const options = build.props.options as {
          effect: { main: string };
        };
        expect(options.effect.main).toContain("EffectfulPlan.test.ts");
        expect(options.effect).not.toHaveProperty("routes");
      }),
  );

  dev.test.provider(
    "dev: Vite SSR (wrapper tier) threads the effect build options into the dev Server",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Vite(
              "DevViteSsr",
              { ssr: true, main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        // The user's server-entry mount owns dev HTTP (Serve/DESIGN.md);
        // the effect options only carry the anchor.
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        expect(build.props.framework).toBe(
          "@alchemy.run/frontend-frameworks/vite",
        );
        const options = build.props.options as {
          effect: { main: string };
        };
        expect(options.effect.main).toContain("EffectfulPlan.test.ts");
        expect(options.effect).not.toHaveProperty("routes");
        // The effect program deploys as the local emulator sibling.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.main).toBe(import.meta.url);
        expect(server.props.runtimeDelivery).toBeUndefined();
        // No CDN resources are declared in dev.
        expect(nodeOf(plan, "Distribution")).toBeUndefined();
      }),
  );

  dev.test.provider(
    "dev: Nextjs threads no dispatch options (the route-file mount owns dev HTTP)",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            yield* AWS.Website.Nextjs(
              "DevNext",
              { main: import.meta.url },
              Effect.succeed(okFetch),
            );
          }),
        );
        // Mount design (Serve/DESIGN.md): the user's route-file mount runs
        // natively inside `next dev` — the dev child gets NO effect
        // dispatch options; the lowered env (markers + packed bindings) is
        // what the mount's env ladder resolves.
        const build = nodeOf(plan, "Build", "AWS.Website.Server");
        expect(build).toBeDefined();
        expect(build.props.options).toBeUndefined();
      }),
  );

});

// ─────────────────────────────────────────────────────────────────────
// The wiring handshake over a framework-shaped prebuilt artifact: the
// composite ships the server directory as-is (`bundle: false`), so the
// deploy-time sentinel scan is the only proof the user actually mounted
// the program via `alchemy/Serve` on the explicit tier.
// ─────────────────────────────────────────────────────────────────────

describe.concurrent("composite artifact sentinel scan (bundler unit)", () => {
  const bundler = Effect.provide(makeFunctionBundler, NodeServices.layer);

  it.effect(
    "external delivery over an unmounted framework dist fails the handshake",
    () =>
      Effect.gen(function* () {
        const { bundleCode } = yield* bundler;
        const exit = yield* Effect.exit(
          bundleCode("Server", {
            // The exact props shape the effectful composites produce.
            main: unmountedDist,
            handler: "handler",
            bundle: false,
            runtimeDelivery: "external",
          } as any).pipe(Effect.provide(NodeServices.layer)),
        );
        const failure = failureOf(exit);
        expect(failure?._tag).toBe("MissingServeMountError");
        expect(String(failure?.message)).toContain("alchemy/Serve");
      }),
  );

  it.effect("a mounted framework dist passes the handshake", () =>
    Effect.gen(function* () {
      const { bundleCode } = yield* bundler;
      const result = yield* bundleCode("Server", {
        main: mountedDist,
        handler: "handler",
        bundle: false,
        runtimeDelivery: "external",
      } as any).pipe(Effect.provide(NodeServices.layer));
      expect(result.identityHash.length).toBeGreaterThan(0);
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────
// The wrapper-entry helper itself (plumbing for the auto-inject tier).
// ─────────────────────────────────────────────────────────────────────

describe.concurrent("prepareServerWrapperEntry", () => {
  it.effect("writes the entry under <root>/.alchemy/generated/<id>", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-aws-wrapper-entry-",
      });
      const mainA = path.join(root, "site-a.ts");
      yield* fs.writeFileString(mainA, "export default 1;\n");

      const prepared = yield* prepareServerWrapperEntry({
        id: "Site",
        rootDir: root,
        main: mainA,
        routes: ["/api/*"],
        code: ({ mainPath, routes }) =>
          `import Site from ${JSON.stringify(mainPath)};\n` +
          `export const routes = ${JSON.stringify(routes)};\n`,
      });
      expect(prepared.entryPath).toBe(
        path.join(root, ".alchemy", "generated", "Site", "entry.mjs"),
      );
      const written = yield* fs.readFileString(prepared.entryPath);
      expect(written).toContain(JSON.stringify(mainA));
      expect(written).toContain('"/api/*"');
      expect(prepared.effectHash).toMatch(/^[0-9a-f]{64}$/);

      // The hash keys on the effect module's CONTENT: an edit changes it
      // (that is what folds into the Server memo surface so effect edits
      // rebuild), while an identical re-run is stable.
      const stable = yield* prepareServerWrapperEntry({
        id: "Site",
        rootDir: root,
        main: mainA,
        routes: ["/api/*"],
        code: ({ mainPath, routes }) =>
          `import Site from ${JSON.stringify(mainPath)};\n` +
          `export const routes = ${JSON.stringify(routes)};\n`,
      });
      expect(stable.effectHash).toBe(prepared.effectHash);

      yield* fs.writeFileString(mainA, "export default 2;\n");
      const edited = yield* prepareServerWrapperEntry({
        id: "Site",
        rootDir: root,
        main: mainA,
        routes: ["/api/*"],
        code: ({ mainPath, routes }) =>
          `import Site from ${JSON.stringify(mainPath)};\n` +
          `export const routes = ${JSON.stringify(routes)};\n`,
      });
      expect(edited.effectHash).not.toBe(prepared.effectHash);

      yield* fs.remove(root, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ─────────────────────────────────────────────────────────────────────
// The Lambda serve shell rides EVERY effectful class arm: the shell is
// attached at class construction (no deploy involved), so `Serve.toHandler` —
// and the framework mounts built on it — dispatches through the
// Lambda/Node layer recipe instead of the Cloudflare-flavored bridge.
// ─────────────────────────────────────────────────────────────────────

describe.concurrent("effectful class arms carry the Lambda serve shell", () => {
  it("all seven framework class arms attach the shell statics", () => {
    class ShellPlanAstro extends AWS.Website.Astro<ShellPlanAstro>()(
      "ShellPlanAstro",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanSvelte extends AWS.Website.SvelteKit<ShellPlanSvelte>()(
      "ShellPlanSvelte",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanWaku extends AWS.Website.Waku<ShellPlanWaku>()(
      "ShellPlanWaku",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanOctane extends AWS.Website.Octane<ShellPlanOctane>()(
      "ShellPlanOctane",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanStatic extends AWS.Website.StaticSite<ShellPlanStatic>()(
      "ShellPlanStatic",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanNext extends AWS.Website.Nextjs<ShellPlanNext>()(
      "ShellPlanNext",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanNuxt extends AWS.Website.Nuxt<ShellPlanNuxt>()(
      "ShellPlanNuxt",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanVite extends AWS.Website.Vite<ShellPlanVite>()(
      "ShellPlanVite",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class ShellPlanViteSsr extends AWS.Website.Vite<ShellPlanViteSsr>()(
      "ShellPlanViteSsr",
      { ssr: true, main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    for (const cls of [
      ShellPlanAstro,
      ShellPlanSvelte,
      ShellPlanWaku,
      ShellPlanOctane,
      ShellPlanStatic,
      ShellPlanNext,
      ShellPlanNuxt,
      ShellPlanVite,
      ShellPlanViteSsr,
    ]) {
      const shell = (cls as any)[SERVE_BRIDGE_KEY];
      expect(shell).toBeDefined();
      expect(typeof shell.match).toBe("function");
      expect(typeof shell.dispose).toBe("function");
      expect(typeof shell.runtime).toBe("function");
    }
  });

  it("the Vite arm is StaticSite with the Vite conventions defaulted", async () => {
    // The thin-arm contract: `rootDir` becomes `path`, the build/dev
    // commands are the standard Vite invocations resolved against the
    // PROJECT's node_modules/.bin (PATH-prepended — `npx` walks node's
    // package tree and can land on an unrelated vite), spa fallback is
    // on, and explicit overrides win untouched.
    const { viteDefaults } = await import("@/AWS/Website/Vite.ts");

    const defaulted = viteDefaults({ rootDir: "apps/web" }) as any;
    expect(defaulted.path).toBe("apps/web");
    expect(defaulted.spa).toBe(true);
    expect(defaulted.build.command).toBe("vite build");
    expect(defaulted.build.output).toBe("dist");
    expect(defaulted.dev.command).toBe("vite dev");
    // The project's bin dir leads PATH for both the build and dev worlds.
    const binPrefix = `${process.cwd()}/apps/web/node_modules/.bin`;
    expect(defaulted.environment.PATH.startsWith(binPrefix)).toBe(true);
    expect(defaulted.dev.env.PATH.startsWith(binPrefix)).toBe(true);

    // The SPA discriminant never leaks into the StaticSite props (it
    // would otherwise persist in resource state).
    const discriminated = viteDefaults({ ssr: false }) as any;
    expect("ssr" in discriminated).toBe(false);

    const overridden = viteDefaults({
      spa: false,
      build: { command: "bun run build", output: "out" },
      dev: { command: "bun run dev" },
    }) as any;
    expect(overridden.spa).toBe(false);
    expect(overridden.build.command).toBe("bun run build");
    expect(overridden.build.output).toBe("out");
    expect(overridden.dev.command).toBe("bun run dev");
    // An explicit build keeps the user's environment untouched.
    expect(overridden.environment).toBeUndefined();
  });
});
