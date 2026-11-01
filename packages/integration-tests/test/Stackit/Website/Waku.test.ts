import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { noBuiltFunctions } from "../Functions/helpers.ts";
import { hostingFor } from "./fixtures/stack.ts";
import {
  awsFixture,
  expectFunctionServing,
  expectServerSiteGone,
  expectThroughCdn,
  liveOptions,
  logLevel,
  tempRoot,
} from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers() });

const fixtureDir = awsFixture("waku-app");
const fixtureEntries = [".gitignore", "package.json", "tsconfig.json", "src", "public"];

describe.skipIf(noBuiltFunctions)("Stackit.Website.Waku", () => {
  test.provider(
    "server-rendered on a Function, through the CDN",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-waku-stackit-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const hosting = yield* hostingFor("waku");
            const site = yield* Stackit.Website.Waku("Web", {
              ...hosting,
              rootDir,
              memo: { include: ["src/**", "public/**", "package.json", "tsconfig.json"] },
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

        yield* expectUrlContains(`${site.url}/`, "WAKU_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "Waku / through the CDN",
        });
        // The query comes back, which no cached or static response could do.
        yield* expectUrlContains(`${site.url}/echo?echo=roundtrip`, "roundtrip", {
          timeout: "60 seconds",
          label: "Waku dynamic route through the CDN",
        });
        // The same route answers from the function itself.
        yield* expectUrlContains(`${origin}/echo?echo=roundtrip`, "WAKU_AWS_API_MARKER", {
          timeout: "60 seconds",
          label: "Waku dynamic route on the function",
        });
        yield* stack.destroy();
        yield* expectServerSiteGone(site, server!.functionId);
      }).pipe(logLevel),
    liveOptions(),
  );
});
