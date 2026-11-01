import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: Stackit.providers(), dev: true });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/staticsite-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

describe(
  "Stackit.Website.StaticSite local",
  { tags: ["provider:stackit", "provider:stackit:website", "local"] },
  () => {
    test.provider(
      "dev builds and serves outdir locally with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const cwd = yield* cloneFixture(fixtureDir, {
            prefix: "alchemy-staticsite-stackit-local-",
            tempRoot,
            entries: ["src", "build.sh"],
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* Stackit.Website.StaticSite("Blog", {
                cwd,
                command: "bash build.sh",
                outdir: "dist",
              });
              return { site };
            }),
          );

          const url = deployed.site.url;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
          expect(deployed.site.server).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "StaticSite fixture v1", {
            timeout: "90 seconds",
            label: "dev staticsite index",
          });

          yield* stack.destroy();
        }),
      {
        tags: ["provider:stackit", "provider:stackit:website", "local"],
        timeout: 120_000,
      },
    );
  },
);
