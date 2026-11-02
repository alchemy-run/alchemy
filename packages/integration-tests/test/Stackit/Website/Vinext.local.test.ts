import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { exampleDir } from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers(), dev: true });

// Run in place: vinext and its RSC toolchain resolve only from the example's own
// node_modules.
const rootDir = exampleDir("fly-website-vinext");

describe(
  "Stackit.Website.Vinext local",
  { tags: ["provider:stackit", "provider:stackit:website", "local"] },
  () => {
    test.provider(
      "dev runs vinext's own dev server with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* Stackit.Website.Vinext("Web", {
                rootDir,
                env: { GREETING: "Hello from vinext in dev" },
              });
              return { site };
            }),
          );

          const url = deployed.site.url;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
          expect(deployed.site.server).toBeUndefined();
          expect(deployed.site.distribution).toBeUndefined();

          yield* expectUrlContains(`${url}/api/hello?name=Alchemy`, "Hello from vinext in dev", {
            timeout: "90 seconds",
            label: "dev env-backed route",
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
