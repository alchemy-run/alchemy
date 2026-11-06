import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { prepareNextjsFixture } from "../../Cloudflare/Website/TypeScriptCompat.ts";

const { test } = Test.make({ providers: Archil.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/nextjs-app");
const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
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
  "Nextjs: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
      // Next treat the alchemy monorepo as the workspace root and look up
      // the root's typescript (catalog:build = tsgo, which has no JS compiler).
      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-nextjs-archil-",
        entries: fixtureEntries,
      });
      yield* prepareNextjsFixture(rootDir);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Archil.Website.Nextjs("Web", {
            rootDir,
            memo: {
              include: ["app/**", "public/**", "package.json", "next.config.ts", "tsconfig.json"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.sandbox!.port).toBe(3000);

      yield* expectUrlContains(`${url!}/`, "NEXTJS_AWS_PAGE_MARKER", {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/api/hello?echo=roundtrip`, "NEXTJS_AWS_API_MARKER", {
        timeout: "30 seconds",
        label: "api route",
      });
      yield* expectUrlContains(`${url!}/static`, "NEXTJS_AWS_STATIC_MARKER", {
        timeout: "30 seconds",
        label: "extra route",
      });

      const sandboxId = deployed.site.sandbox!.sandboxId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(sandboxId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: ["provider:archil", "provider:archil:sandbox", "provider:archil:website", "live"],
    timeout: 240000,
  },
);
