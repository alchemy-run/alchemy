import * as Fly from "@/Fly/index.ts";
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
import * as api from "@distilled.cloud/fly-io/machines";

const { test } = Test.make({ providers: Fly.providers() });

describe.sequential(
  "Fly Foldkit rendering modes",
  { tags: ["provider:fly", "provider:fly:website", "live"] },
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
                Fly.Website.Foldkit("Web", {
                  rootDir,
                  memo: foldkitMemo,
                }),
              );
              expect(site.url).toBeDefined();
              expect(site.app).toBeDefined();
              const appName = site.app!.appName;
              expect((yield* api.getApp({ app_name: appName })).name).toBe(
                appName,
              );
              yield* verifyFoldkitRendering(site.url!, mode);
              if (check === "browser")
                yield* verifyFoldkitBrowser(site.url!, mode);
              yield* stack.destroy();
              const gone = yield* api
                .getApp({ app_name: appName })
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
            tags: [check === "browser" ? "browser" : "http"],
            timeout: 120_000,
          },
        );
      }
    }
  },
);
