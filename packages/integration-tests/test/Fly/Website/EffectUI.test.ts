import * as Fly from "@alchemy.run/fly";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  effectUIFixture,
  effectUIMemo,
  effectUIModes,
  verifyEffectUIRendering,
} from "../../Website/EffectUI.ts";
import { flyApi } from "../limit.ts";

const { test } = Test.make({ limit: flyApi, providers: Fly.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

describe.sequential(
  "Fly EffectUI rendering modes",
  { tags: ["provider:fly", "provider:fly:machine", "provider:fly:website", "live"] },
  () => {
    for (const mode of effectUIModes) {
      test.provider.skipIf(mode !== "spa" && !!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* effectUIFixture(mode);

            const site = yield* stack.deploy(
              Fly.Website.EffectUI("Web", { rootDir, memo: effectUIMemo }),
            );
            expect(site.url).toMatch(/^https:\/\//);
            expect(site.app).toBeDefined();
            const appName = site.app!.appName;
            expect((yield* machines.getApp({ app_name: appName })).name).toBe(appName);
            yield* verifyEffectUIRendering(site.url!, mode, { runtime: /Node\.js/ });

            yield* stack.destroy();
            expect(yield* waitUntilGone(appName)).toEqual("gone");
          }).pipe(logLevel),
        { timeout: 180_000 },
      );
    }
  },
);
