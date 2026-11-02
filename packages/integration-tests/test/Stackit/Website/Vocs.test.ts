import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
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
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers() });

const fixtureDir = exampleDir("cloudflare-website-vocs");
const fixtureEntries = ["package.json", "public", "src", "tsconfig.json", "vocs.config.ts"];

describe.skipIf(noBuiltFunctions)("Stackit.Website.Vocs", () => {
  test.provider(
    "server-rendered on a Function, through the CDN",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-vocs-stackit-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const hosting = yield* hostingFor("vocs");
            const site = yield* Stackit.Website.Vocs("Web", {
              ...hosting,
              rootDir,
              memo: {
                include: ["src/**", "public/**", "package.json", "tsconfig.json", "vocs.config.ts"],
              },
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

        yield* expectUrlContains(`${site.url}/`, "Alchemy with Vocs", {
          timeout: "180 seconds",
          label: "Vocs / through the CDN",
        });
        // The page renders on the function itself, too.
        yield* expectUrlContains(`${origin}/`, "Alchemy with Vocs", {
          timeout: "60 seconds",
          label: "Vocs / on the function",
        });
        yield* stack.destroy();
        yield* expectServerSiteGone(site, server!.functionId);
      }).pipe(logLevel),
    liveOptions(),
  );
});
