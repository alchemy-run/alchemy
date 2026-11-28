import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import {
  effectUIFixture,
  effectUIMemo,
  effectUIModes,
  verifyEffectUIRendering,
} from "../../Website/EffectUI.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

describe.concurrent(
  "EffectUI",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:website",
      "provider:cloudflare:worker",
      "live",
    ],
  },
  () => {
    // Each rendering mode, deployed from its own fixture clone: prerendered
    // pages are assets, everything else reaches the generated Worker.
    for (const mode of effectUIModes) {
      test.provider(
        `EffectUI: ${mode} renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;

            yield* stack.destroy();

            const rootDir = yield* effectUIFixture(mode);
            const site = yield* stack.deploy(
              Cloudflare.Website.EffectUI(`FixEffectUI${mode}`, {
                rootDir,
                workersDev: true,
                compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
                memo: effectUIMemo,
              }),
            );

            expect(site.url).toBeDefined();
            yield* expectWorkerExists(site.workerName, accountId);
            yield* verifyEffectUIRendering(site.url!, mode, { runtime: /Cloudflare-Workers/ });

            yield* stack.destroy();
            yield* waitForWorkerToBeDeleted(site.workerName, accountId);
          }).pipe(logLevel),
        { timeout: 180_000 },
      );
    }

    // A browser-only app with a custom `main`: the Worker answers its own
    // routes and the asset layer still falls back to the shell.
    test.provider(
      "EffectUI: a browser-only app runs behind a custom Worker entry",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* effectUIFixture("spa", {
            overlay: pathe.resolve(import.meta.dirname, "effect-ui-worker"),
          });
          const site = yield* stack.deploy(
            Cloudflare.Website.EffectUI("FixEffectUIMain", {
              rootDir,
              main: "src/worker.ts",
              workersDev: true,
              compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
              memo: effectUIMemo,
              env: { GREETING: "hello from main" },
              assets: { runWorkerFirst: ["/api/*"] },
            }),
          );

          yield* expectWorkerExists(site.workerName, accountId);
          yield* expectUrlContains(`${site.url!}/api/greeting`, "hello from main", {
            timeout: "30 seconds",
            label: "effect-ui custom worker route",
          });
          yield* verifyEffectUIRendering(site.url!, "spa");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { timeout: 180_000 },
    );

    // Server code reads the Worker's bindings from `cloudflare:workers`,
    // imported per request since the build prerenders in Node.
    test.provider(
      "EffectUI: server code reads Worker bindings",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* effectUIFixture("hybrid", {
            overlay: pathe.resolve(import.meta.dirname, "effect-ui-env"),
          });
          const site = yield* stack.deploy(
            Cloudflare.Website.EffectUI("FixEffectUIEnv", {
              rootDir,
              workersDev: true,
              compatibility: { date: "2026-11-01", flags: ["nodejs_compat"] },
              memo: effectUIMemo,
              env: { GREETING: "hello from the Worker" },
            }),
          );

          yield* expectWorkerExists(site.workerName, accountId);
          yield* expectUrlContains(`${site.url!}/__greeting`, "hello from the Worker", {
            timeout: "30 seconds",
            label: "effect-ui binding",
          });
          // Pages still render and prerender alongside it.
          yield* verifyEffectUIRendering(site.url!, "hybrid");

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
