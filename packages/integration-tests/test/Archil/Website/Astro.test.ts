import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Archil.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const fixtureDir = pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures/astro-app");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const fixtureEntries = [".gitignore", "package.json", "astro.config.mjs", "src", "public"];

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
  "Astro SSR: GET / and a dynamic API route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-astro-archil-",
        tempRoot,
        entries: fixtureEntries,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Archil.Website.Astro("Web", {
            rootDir,
            memo: {
              include: ["src/**", "public/**", "package.json", "astro.config.mjs"],
            },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.sandbox!.port).toBe(3000);

      yield* expectUrlContains(`${url!}/`, "ASTRO_AWS_PAGE_MARKER", {
        timeout: "90 seconds",
        label: "astro ssr home",
      });
      yield* expectUrlContains(`${url!}/api/hello?echo=roundtrip`, "ASTRO_AWS_API_MARKER", {
        timeout: "30 seconds",
        label: "astro api route",
      });

      const client = yield* HttpClient.HttpClient;
      const health = yield* client.get(`${url!}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? res.text : Effect.fail(new Error(`health returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      expect(health).toContain("ok");

      const sandboxId = deployed.site.sandbox!.sandboxId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(sandboxId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: ["provider:archil", "provider:archil:sandbox", "provider:archil:website", "live"],
    timeout: 420_000,
  },
);
