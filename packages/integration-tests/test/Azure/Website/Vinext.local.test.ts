import * as Azure from "@alchemy.run/azure";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

// `dev: true` runs local providers behind the RPC sidecar, like `alchemy dev`.
const { test } = Test.make({ providers: Azure.providers(), dev: true });

// vinext and its RSC toolchain resolve only from the example's own node_modules.
const rootDir = pathe.resolve(import.meta.dirname, "../../../../../examples/azure-website-vinext");

describe(
  "Azure.Website.Vinext local",
  { tags: ["provider:azure", "provider:azure:website", "local"] },
  () => {
    test.provider(
      "dev runs vinext dev with no Azure resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Azure.Website.Vinext("Web", {
                rootDir,
                env: { GREETING: "vinext-azure-dev-env" },
              });
            }),
          );

          // The site is `vinext dev`: a localhost URL and no Azure resources
          // (proof no Azure call ran).
          const url = site.url as string;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/);
          expect(site.server).toBeUndefined();
          expect(site.frontDoor).toBeUndefined();
          expect(site.storageAccount).toBeUndefined();

          yield* expectUrlContains(`${url}/`, "Hello from vinext on Azure!", {
            timeout: "120 seconds",
            label: "dev home page",
          });
          // `env` reaches the dev server's process env.
          yield* expectUrlContains(`${url}/api/hello?name=Alchemy`, "vinext-azure-dev-env", {
            label: "route handler env (dev)",
          });

          yield* stack.destroy();
        }),
      { timeout: 600_000 },
    );
  },
);
