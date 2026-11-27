import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import {
  effectUIFixture,
  effectUIMemo,
  effectUIModes,
  verifyEffectUIRendering,
} from "../../Website/EffectUI.ts";
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
  },
);
