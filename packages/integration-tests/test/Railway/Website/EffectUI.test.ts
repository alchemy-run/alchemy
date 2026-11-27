import * as Railway from "@alchemy.run/railway";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  effectUIFixture,
  effectUIMemo,
  effectUIModes,
  verifyEffectUIRendering,
} from "../../Website/EffectUI.ts";
import { suitePartition } from "../suiteProject.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const readService = Query.fn((id: string) => ({ deletedAt: RailwayApi.service({ id }).deletedAt }));

const waitUntilGone = (serviceId: string) =>
  readService(serviceId).pipe(
    Effect.map((service) => (service.deletedAt != null ? ("gone" as const) : ("found" as const))),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

describe.sequential(
  "Railway EffectUI rendering modes",
  { tags: ["provider:railway", "provider:railway:website", "live"] },
  () => {
    for (const mode of effectUIModes) {
      test.provider.skipIf(mode !== "spa" && !!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* effectUIFixture(mode);
            const site = yield* stack.deploy(
              Effect.gen(function* () {
                const { project, environment } = yield* suitePartition;
                return yield* Railway.Website.EffectUI("Web", {
                  rootDir,
                  memo: effectUIMemo,
                  project,
                  environment,
                });
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.service).toBeDefined();
            const serviceId = site.service!.serviceId;
            expect((yield* readService(serviceId)).deletedAt == null).toBe(true);
            yield* verifyEffectUIRendering(site.url!, mode, { runtime: /Node\.js/ });

            yield* stack.destroy();
            expect(yield* waitUntilGone(serviceId)).toEqual("gone");
          }).pipe(logLevel),
        { timeout: 180_000 },
      );
    }
  },
);
