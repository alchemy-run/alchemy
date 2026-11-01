import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { noBuiltFunctions } from "../Functions/helpers.ts";
import { hostingFor } from "./fixtures/stack.ts";
import {
  exampleDir,
  expectFunctionServing,
  expectServerSiteGone,
  expectThroughCdn,
  liveOptions,
  logLevel,
} from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers() });

// Built in place: vinext and its RSC toolchain resolve only from the example's
// own node_modules (build output is gitignored there).
const rootDir = exampleDir("fly-website-vinext");

describe.skipIf(noBuiltFunctions)("Stackit.Website.Vinext", () => {
  test.provider(
    "server-rendered on a Function, through the CDN",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const hosting = yield* hostingFor("vinext");
            const site = yield* Stackit.Website.Vinext("Web", {
              ...hosting,
              rootDir,
              memo: {
                include: ["app/**", "public/**", "package.json", "vite.config.ts", "tsconfig.json"],
              },
              env: { GREETING: "Hello from vinext on STACKIT Functions!" },
            });
            return { site };
          }),
        );

        const { distribution, server, serverUrl } = deployed.site;
        const site = {
          url: deployed.site.url as string,
          projectId: distribution!.projectId,
          distributionId: distribution!.distributionId,
          hostname: distribution!.hostname,
        };
        const origin = serverUrl as string;
        expect(origin).toMatch(/^https:\/\//);
        yield* expectThroughCdn(site, { type: "http", originUrl: origin });
        yield* expectFunctionServing(site.projectId, server!);

        // The env var is set only on the function, so it answered this.
        yield* expectUrlContains(
          `${site.url}/api/hello?name=Alchemy`,
          "Hello from vinext on STACKIT Functions!",
          { timeout: "180 seconds", label: "Vinext env-backed route through the CDN" },
        );

        yield* stack.destroy();
        yield* expectServerSiteGone(site, server!.functionId);
      }).pipe(logLevel),
    liveOptions(),
  );
});
