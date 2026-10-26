import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { runExpensive } from "../gates.ts";
import {
  assertGroupGone,
  FRONT_DOOR_TIMEOUT,
  frontDoorUrl,
  frontDoorWait,
  getProfile,
  LOCATION,
  logLevel,
  viaFrontDoor,
  waitForPage,
} from "./site.ts";

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

    // ~$0.10/run, 35-55 min: a server build needs Front Door (10-20 min
    // endpoint propagation, 15-30 min profile delete). Run with
    // AZURE_TEST_EXPENSIVE=1.
    test.provider.skipIf(!runExpensive)(
      "Alchemy.remote() deploys the site to Azure during dev",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Azure.Website.Vinext("Web", {
                rootDir,
                location: LOCATION,
                env: { GREETING: "vinext-azure-remote-env" },
                memo: {
                  include: [
                    "app/**",
                    "public/**",
                    "package.json",
                    "vite.config.ts",
                    "tsconfig.json",
                  ],
                },
              });
            }).pipe(Alchemy.remote()),
          );

          // A real Front Door endpoint and a real Function app.
          const url = site.url as string;
          expect(url).toMatch(frontDoorUrl);
          const server = site.server!;
          expect(server.functionAppId).toMatch(/^\/subscriptions\//);

          // Out of band: the live Function app carries the app setting.
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const settings = yield* web.ListWebAppApplicationSettings({
            subscriptionId,
            resourceGroupName: server.resourceGroup,
            name: server.functionAppName,
          });
          expect(settings.properties?.GREETING).toBe("vinext-azure-remote-env");

          const api = yield* waitForPage(
            `${url}/api/hello?name=Alchemy`,
            (page) => page.status === 200,
            frontDoorWait,
          );
          expect(viaFrontDoor(api)).toBe(true);
          expect(JSON.parse(api.body)).toEqual({
            name: "Alchemy",
            greeting: "vinext-azure-remote-env",
          });

          // Destroy deletes the live resources (rows stamped `live`).
          const groupName = site.resourceGroup!.resourceGroupName;
          const profileGroup = site.frontDoor!.profile.resourceGroup;
          const profileName = site.frontDoor!.profile.profileName;
          yield* stack.destroy();
          expect(yield* getProfile(profileGroup, profileName)).toBeUndefined();
          yield* assertGroupGone(groupName);
        }).pipe(logLevel),
      { timeout: FRONT_DOOR_TIMEOUT },
    );
  },
);
