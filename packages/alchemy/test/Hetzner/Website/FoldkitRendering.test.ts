import * as Hetzner from "@/Hetzner/index.ts";
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
import * as api from "@distilled.cloud/hetzner/servers";

const { test } = Test.make({ providers: Hetzner.providers() });

describe.sequential(
  "Hetzner Foldkit rendering modes",
  { tags: ["provider:hetzner", "provider:hetzner:website", "live"] },
  () => {
    for (const mode of foldkitModes) {
      for (const check of foldkitChecks) {
        test.provider.skipIf(
          !!process.env.FAST ||
            (check === "browser" && !browserEnabled) ||
            !process.env.HCLOUD_TOKEN,
        )(
          `${mode}: ${check === "browser" ? "browser hydration" : "HTTP rendering"} and cleanup`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const rootDir = yield* foldkitFixture(mode);

              const site = yield* stack.deploy(
                Hetzner.Website.Foldkit("Web", {
                  rootDir,
                  memo: foldkitMemo,
                }),
              );
              expect(site.url).toBeDefined();
              expect(site.server).toBeDefined();
              const serverId = site.server!.serverId;
              yield* api.getServer({ id: serverId });
              yield* verifyFoldkitRendering(site.url!, mode);
              if (check === "browser")
                yield* verifyFoldkitBrowser(site.url!, mode);
              yield* stack.destroy();
              const gone = yield* api
                .getServer({ id: serverId })
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
