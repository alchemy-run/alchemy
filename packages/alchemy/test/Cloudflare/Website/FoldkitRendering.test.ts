import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as workers from "@distilled.cloud/cloudflare/workers";
import {
  browserEnabled,
  foldkitChecks,
  foldkitFixture,
  foldkitMemo,
  foldkitModes,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/FoldkitRendering.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { expectWorkerExists } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

describe.sequential(
  "Cloudflare Foldkit rendering modes",
  { tags: ["provider:cloudflare", "provider:cloudflare:website", "live"] },
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
              const { accountId } = yield* yield* CloudflareEnvironment;
              const site = yield* stack.deploy(
                Cloudflare.Website.Foldkit("Web", {
                  rootDir,
                  memo: foldkitMemo,
                  workersDev: true,
                  compatibility: {
                    date: "2024-09-23",
                    flags: ["nodejs_compat"],
                  },
                }),
              );
              expect(site.url).toBeDefined();
              yield* expectWorkerExists(site.workerName, accountId);
              yield* verifyFoldkitRendering(site.url!, mode);
              if (check === "browser")
                yield* verifyFoldkitBrowser(site.url!, mode);
              yield* stack.destroy();
              const gone = yield* workers
                .getScript({ accountId, scriptName: site.workerName })
                .pipe(
                  Effect.as(false),
                  Effect.catchTag(
                    ["WorkerNotFound", "WorkerHasNoVersions"],
                    () => Effect.succeed(true),
                  ),
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
