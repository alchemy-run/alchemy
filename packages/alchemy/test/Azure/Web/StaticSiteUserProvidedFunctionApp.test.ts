import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import {
  flexApp,
  flexConnectionString,
  flexPlanRejection,
  flexStorage,
} from "./fixtures/flex-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getRegistration = (
  resourceGroupName: string,
  name: string,
  functionAppName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetStaticSiteUserProvidedFunctionAppForStaticSite({
      subscriptionId,
      resourceGroupName,
      name,
      functionAppName,
    });
  });

const registrationGone = (
  resourceGroupName: string,
  name: string,
  functionAppName: string,
) =>
  getRegistration(resourceGroupName, name, functionAppName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (connection: string, register: boolean) =>
  Effect.gen(function* () {
    const { group, app } = yield* flexApp(connection);
    const site = yield* Azure.Web.StaticSite("Site", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const registration = register
      ? yield* Azure.Web.StaticSiteUserProvidedFunctionApp("Api", {
          resourceGroup: group.resourceGroupName,
          staticSiteName: site.staticSiteName,
          functionAppResourceId: app.siteId,
          functionAppRegion: app.location,
        })
      : undefined;
    return { group, app, site, registration };
  });

// The testing subscription may not create Flex Consumption plans (HTTP 502
// "The subscription '<id>' is not allowed to create or update the
// serverfarm.", ServerFarmCreateNotAllowed, in every region), so this runs
// only with AZURE_TEST_PAID=1. Cost: Standard static site
// ~$9/month prorated (~$0.0125/h, a few cents per run); Flex Consumption
// idle $0. Provisioning: ~4-6 minutes.
test.provider.skipIf(!runPaidOnly)(
  "register and detach a user-provided function app on a static site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { app, site, registration } = yield* stack.deploy(
        program(connection, true),
      );
      expect(registration!.functionAppName).toEqual(app.siteName);
      expect(registration!.functionAppResourceId.toLowerCase()).toEqual(
        app.siteId.toLowerCase(),
      );
      const observed = yield* getRegistration(
        group.resourceGroupName,
        site.staticSiteName,
        app.siteName,
      );
      expect(observed.properties?.functionAppResourceId?.toLowerCase()).toEqual(
        app.siteId.toLowerCase(),
      );

      // A redeploy without changes keeps the registration.
      const same = yield* stack.deploy(program(connection, true));
      expect(same.registration!.userProvidedFunctionAppId).toEqual(
        registration!.userProvidedFunctionAppId,
      );

      // Detach only the function app.
      yield* stack.deploy(program(connection, false));
      expect(
        yield* registrationGone(
          group.resourceGroupName,
          site.staticSiteName,
          app.siteName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

// Probe: the subscription cannot create the Flex Consumption plan this
// lifecycle needs.
test.provider.skipIf(runPaidOnly)(
  "flex consumption plan is rejected with ServerFarmCreateNotAllowed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* flexPlanRejection(group.resourceGroupName);
      expect(error._tag).toEqual("ServerFarmCreateNotAllowed");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 300_000,
  },
);
