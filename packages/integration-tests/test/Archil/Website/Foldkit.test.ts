import * as Archil from "@alchemy.run/archil";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  foldkitFixture,
  foldkitMemo,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/Foldkit.ts";

const { test } = Test.make({ providers: Archil.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "../../Cloudflare/Website/foldkit-fixture");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = ["index.html", "package.json", "vite.config.ts", "src"];

const waitUntilGone = (sid: string) =>
  archil.getSandbox({ sid }).pipe(
    Effect.map(({ data }) => (data.status === "deleted" ? ("gone" as const) : ("found" as const))),
    Effect.catchTag("SandboxNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

test.provider(
  "Foldkit: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-foldkit-archil-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Archil.Website.Foldkit("Web", {
            rootDir,
            memo: {
              include: ["index.html", "src/**", "package.json", "vite.config.ts"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.sandbox!.port).toBe(3000);

      yield* expectUrlContains(`${url!}/`, "Foldkit Fixture", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/counter/42`, "Foldkit Fixture", {
        timeout: "30 seconds",
        label: "spa fallback",
      });

      const sandboxId = deployed.site.sandbox!.sandboxId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(sandboxId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: ["provider:archil", "provider:archil:sandbox", "provider:archil:website", "live"],
    timeout: 180000,
  },
);

describe.sequential(
  "Archil Foldkit rendering modes",
  { tags: ["provider:archil", "provider:archil:website", "live"] },
  () => {
    for (const mode of ["ssg", "ssr", "hybrid"] as const) {
      test.provider.skipIf(!!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* foldkitFixture(mode);

            const site = yield* stack.deploy(
              Archil.Website.Foldkit("Web", {
                rootDir,
                memo: foldkitMemo,
              }),
            );
            expect(site.url).toMatch(/^https:\/\//);
            const sandboxId = site.sandbox!.sandboxId;
            yield* archil.getSandbox({ sid: sandboxId });
            yield* verifyFoldkitRendering(site.url!, mode);
            yield* verifyFoldkitBrowser(site.url!, mode);
            yield* stack.destroy();
            expect(yield* waitUntilGone(sandboxId)).toEqual("gone");
          }),
        {
          timeout: 420_000,
        },
      );
    }
  },
);
