import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Archil.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/octane-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "octane.config.ts",
  "vite.config.ts",
  "index.html",
  "src",
  "public",
];

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
  "Octane: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-octane-archil-",
        tempRoot,
        entries: fixtureEntries,
      });

      const fs = yield* FileSystem.FileSystem;
      const pathMod = yield* Path.Path;
      const configPath = pathMod.join(rootDir, "octane.config.ts");
      const raw = yield* fs.readFileString(configPath);
      expect(raw).not.toContain("adapter:");
      expect(raw).not.toContain("@alchemy.run/frontend-frameworks");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Archil.Website.Octane("Web", {
            rootDir,
            memo: {
              include: [
                "src/**",
                "public/**",
                "package.json",
                "octane.config.ts",
                "vite.config.ts",
                "index.html",
              ],
            },
          });
          return { site };
        }),
      );

      expect(yield* fs.readFileString(configPath)).toBe(raw);
      const url = deployed.site.url;
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.sandbox!.port).toBe(3000);

      yield* expectUrlContains(`${url!}/`, "OCTANE_AWS_PAGE_MARKER", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/api/hello?echo=roundtrip`, "OCTANE_AWS_API_MARKER", {
        timeout: "30 seconds",
        label: "api route",
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
