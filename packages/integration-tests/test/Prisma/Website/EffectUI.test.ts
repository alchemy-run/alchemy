import * as Prisma from "@alchemy.run/prisma";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getProject } from "@distilled.cloud/prisma/management";
import { getService } from "@distilled.cloud/prisma/unstable/management";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  effectUIFixture,
  effectUIMemo,
  effectUIModes,
  verifyEffectUIRendering,
} from "../../Website/EffectUI.ts";

const { test } = Test.make({ providers: Prisma.providers() });

describe.sequential(
  "Prisma EffectUI rendering modes",
  { tags: ["provider:prisma", "provider:prisma:website", "live"] },
  () => {
    for (const mode of effectUIModes) {
      test.provider.skipIf(
        !!process.env.FAST || process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true",
      )(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* effectUIFixture(mode);

            const site = yield* stack.deploy(
              Prisma.Website.EffectUI("Web", {
                rootDir,
                memo: effectUIMemo,
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.compute).toBeDefined();
            const compute = site.compute!;
            yield* getService({ serviceId: compute.appId });
            // Prisma Compute runs the server on Bun.
            yield* verifyEffectUIRendering(site.url!, mode, { runtime: /Bun\// });
            yield* stack.destroy();
            const gone = yield* getService({ serviceId: compute.appId })
              .pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              )
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  times: 8,
                  until: (gone) => gone,
                }),
              );
            expect(gone).toBe(true);
            expect(
              yield* getProject({ id: compute.projectId }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }),
        {
          timeout: 180_000,
        },
      );
    }
  },
);
