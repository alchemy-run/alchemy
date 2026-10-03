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
  flexStorage,
} from "./fixtures/flex-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const where = (resourceGroupName: string, name: string, slot: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, name, slot };
  });

const getSlot = (resourceGroupName: string, name: string, slot: string) =>
  where(resourceGroupName, name, slot).pipe(Effect.flatMap(web.GetWebAppSlot));

const slotGone = (resourceGroupName: string, name: string, slot: string) =>
  getSlot(resourceGroupName, name, slot).pipe(
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

const program = (props: {
  slotName: string;
  appSettings: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      sku: "S1",
      os: "linux",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      siteConfig: { linuxFxVersion: "NODE|20-lts", alwaysOn: false },
    });
    const slot = yield* Azure.Web.WebAppSlot("Slot", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: props.slotName,
      siteConfig: { linuxFxVersion: "NODE|20-lts", alwaysOn: false },
      appSettings: props.appSettings,
      tags: props.tags,
    });
    return { group, app, slot };
  });

// Deployment slots need a Standard (S1) or higher plan, which has zero VM
// quota on the free trial (see the QuotaExceeded probe in
// AppServicePlan.test.ts). Cost on a paid subscription: ~$0.10/h for S1,
// about $0.02 per run. Provisioning: ~3-5 minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a deployment slot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, slot } = yield* stack.deploy(
        program({
          slotName: "staging",
          appSettings: { STAGE: "staging" },
          tags: { env: "test" },
        }),
      );
      expect(slot.slotName).toEqual("staging");
      expect(slot.defaultHostName).toEqual(
        `${app.siteName}-staging.azurewebsites.net`,
      );
      const observed = yield* getSlot(
        group.resourceGroupName,
        app.siteName,
        "staging",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Slot");
      const settings = yield* where(
        group.resourceGroupName,
        app.siteName,
        "staging",
      ).pipe(Effect.flatMap(web.ListWebAppApplicationSettingsSlot));
      expect(settings.properties).toEqual({ STAGE: "staging" });

      // In-place update: app settings and tags.
      const updated = yield* stack.deploy(
        program({
          slotName: "staging",
          appSettings: { STAGE: "preview", MODE: "test" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.slot.slotId).toEqual(slot.slotId);
      const resettings = yield* where(
        group.resourceGroupName,
        app.siteName,
        "staging",
      ).pipe(Effect.flatMap(web.ListWebAppApplicationSettingsSlot));
      expect(resettings.properties).toEqual({ STAGE: "preview", MODE: "test" });
      const retagged = yield* getSlot(
        group.resourceGroupName,
        app.siteName,
        "staging",
      );
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: the slot name cannot change in place.
      const replaced = yield* stack.deploy(
        program({
          slotName: "preview",
          appSettings: { STAGE: "preview", MODE: "test" },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.slot.slotName).toEqual("preview");
      expect(
        yield* slotGone(group.resourceGroupName, app.siteName, "staging"),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* slotGone(group.resourceGroupName, app.siteName, "preview"),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

// Probe: plans without slots reject them, typed as WebAppSlotsNotSupported.
// Runs on a Flex Consumption app (~$0) since Standard has no trial quota.
test.provider.skipIf(runPaidOnly)(
  "a plan without slots rejects a slot with WebAppSlotsNotSupported",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );
      const { app } = yield* stack.deploy(flexApp(connection));
      const request = yield* where(
        group.resourceGroupName,
        app.siteName,
        "staging",
      );
      const error = yield* web
        .WebAppsCreateOrUpdateSlot({
          ...request,
          location: app.location,
          properties: { serverFarmId: app.serverFarmId },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("WebAppSlotsNotSupported");
      expect(
        yield* slotGone(group.resourceGroupName, app.siteName, "staging"),
      ).toEqual("gone");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
