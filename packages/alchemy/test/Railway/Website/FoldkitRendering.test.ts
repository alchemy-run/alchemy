import * as Railway from "@/Railway/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  browserEnabled,
  foldkitChecks,
  foldkitFixture,
  foldkitMemo,
  foldkitModes,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/FoldkitRendering.ts";
import { Query } from "@distilled.cloud/core/query";
import { Railway as api } from "@distilled.cloud/railway";
import { suitePartition } from "../suiteProject.ts";
const readService = Query.fn((id: string) => ({
  deletedAt: api.service({ id }).deletedAt,
}));

const { test } = Test.make({ providers: Railway.providers() });

describe.sequential(
  "Railway Foldkit rendering modes",
  { tags: ["provider:railway", "provider:railway:website", "live"] },
  () => {
    for (const mode of foldkitModes) {
      for (const check of foldkitChecks) {
        test.provider.skipIf(
          !!process.env.FAST || (check === "browser" && !browserEnabled),
        )(
          `${mode}: ${check === "browser" ? "browser hydration" : "HTTP rendering"} and cleanup`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const rootDir = yield* foldkitFixture(mode);
              const site = yield* stack.deploy(
                Effect.gen(function* () {
                  const { project, environment } = yield* suitePartition;
                  return yield* Railway.Website.Foldkit("Web", {
                    rootDir,
                    memo: foldkitMemo,
                    project,
                    environment,
                  });
                }),
              );
              expect(site.url).toBeDefined();
              expect(site.service).toBeDefined();
              const serviceId = site.service!.serviceId;
              expect((yield* readService(serviceId)).deletedAt == null).toBe(
                true,
              );
              yield* verifyFoldkitRendering(site.url!, mode);
              if (check === "browser")
                yield* verifyFoldkitBrowser(site.url!, mode);
              yield* stack.destroy();
              const gone = yield* readService(serviceId)
                .pipe(
                  Effect.map((service) => service.deletedAt != null),
                  Effect.catchTag("RailwayNotFound", () =>
                    Effect.succeed(true),
                  ),
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
            tags: [check === "browser" ? "browser" : "http"],
            timeout: 120_000,
          },
        );
      }
    }
  },
);
