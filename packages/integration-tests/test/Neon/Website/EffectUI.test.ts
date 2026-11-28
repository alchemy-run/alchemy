import * as Neon from "@alchemy.run/neon";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getProject } from "@distilled.cloud/neon";
import { getProjectBranchFunction } from "@distilled.cloud/neon/unstable/neon";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  effectUIFixture,
  effectUIMemo,
  effectUIModes,
  verifyEffectUIRendering,
} from "../../Website/EffectUI.ts";

const { test } = Test.make({ providers: Neon.providers() });

describe.sequential(
  "Neon EffectUI rendering modes",
  { tags: ["provider:neon", "provider:neon:website", "live"] },
  () => {
    for (const mode of effectUIModes) {
      test.provider.skipIf(mode !== "spa" && !!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* effectUIFixture(mode);

            const site = yield* stack.deploy(
              Neon.Website.EffectUI("Web", {
                rootDir,
                memo: effectUIMemo,
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.function).toBeDefined();
            const fn = site.function!;
            const found = yield* getProjectBranchFunction({
              project_id: fn.projectId,
              branch_id: fn.branchId,
              slug: fn.slug,
            });
            expect(found.function.active_deployment?.id).toBe(fn.activeDeploymentId);
            yield* verifyEffectUIRendering(site.url!, mode, { runtime: /Node\.js/ });
            yield* stack.destroy();
            const gone = yield* getProject({ project_id: fn.projectId })
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
          }),
        {
          timeout: 180_000,
        },
      );
    }
  },
);
