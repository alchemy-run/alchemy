import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldMemoInclude,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";
import { dockerAvailable } from "../bindingHost.ts";
import { assertSiteGone, cloudRunUrl, liveOptions, logLevel, serviceIdentity } from "./site.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!dockerAvailable)(
  "SolidYield: deploy, GET / and a deep link, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-gcp-");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* GCP.Website.SolidYield("Web", {
            rootDir,
            memo: { include: solidYieldMemoInclude },
          });
          return { site };
        }),
      );

      const url = deployed.site.url as string;
      expect(url).toMatch(cloudRunUrl);
      expect(deployed.site.service).toBeDefined();
      const service = serviceIdentity(deployed.site.service!);

      yield* expectSolidYieldBuild(url, {
        timeout: "180 seconds",
        label: "SolidYield /",
      });
      yield* expectUrlContains(`${url}/todos/42`, solidYieldPageMarker, {
        timeout: "30 seconds",
        label: "SolidYield /todos/42",
      });

      yield* stack.destroy();
      yield* assertSiteGone(service);
    }).pipe(logLevel),
  liveOptions(900_000),
);
