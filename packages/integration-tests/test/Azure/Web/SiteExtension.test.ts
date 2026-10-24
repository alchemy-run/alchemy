import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getExtension = (
  resourceGroupName: string,
  name: string,
  siteExtensionId: string,
  slot?: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = { subscriptionId, resourceGroupName, name, siteExtensionId };
    return slot === undefined
      ? yield* web.GetWebAppSiteExtension(where)
      : yield* web.GetWebAppSiteExtensionSlot({ ...where, slot });
  });

const extensionGone = (
  resourceGroupName: string,
  name: string,
  siteExtensionId: string,
  slot?: string,
) =>
  getExtension(resourceGroupName, name, siteExtensionId, slot).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (extensionId: string | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Site extensions need Windows; F1 quota exists in westus3 (centralus plan creates are throttled).
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      sku: "F1",
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "windows",
      siteConfig: { alwaysOn: false },
    });
    const extension =
      extensionId === undefined
        ? undefined
        : yield* Azure.Web.SiteExtension("Extension", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            extensionId,
          });
    return { group, app, extension };
  });

const first = "Microsoft.AspNetCore.AzureAppServices.SiteExtension";
const second = "AspNetCoreRuntime.8.0.x64";

// Cost: $0 (F1 Free plan). Provisioning: ~2-4 minutes.
test.provider(
  "install, replace, and uninstall a site extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, extension } = yield* stack.deploy(program(first));
      expect(extension!.extensionId).toEqual(first);
      const observed = yield* getExtension(group.resourceGroupName, app.siteName, first);
      expect(observed.name).toEqual(`${app.siteName}/${first}`);

      // Replacement: another extension.
      const replaced = yield* stack.deploy(program(second));
      expect(replaced.extension!.extensionId).toEqual(second);
      const installed = yield* getExtension(group.resourceGroupName, app.siteName, second);
      expect(installed.name).toEqual(`${app.siteName}/${second}`);
      expect(yield* extensionGone(group.resourceGroupName, app.siteName, first)).toEqual("gone");

      // Delete only the extension.
      yield* stack.deploy(program(undefined));
      expect(yield* extensionGone(group.resourceGroupName, app.siteName, second)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

const slotProgram = (installed: boolean) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Slots need a Standard (S1) plan; westus2 accepts S1 plans.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "windows",
      siteConfig: { alwaysOn: false },
    });
    const slot = yield* Azure.Web.WebAppSlot("Slot", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: "staging",
      siteConfig: { alwaysOn: false },
    });
    const extension = installed
      ? yield* Azure.Web.SiteExtension("Extension", {
          resourceGroup: group.resourceGroupName,
          siteName: app.siteName,
          slot: slot.slotName,
          extensionId: first,
        })
      : undefined;
    return { group, app, extension };
  });

// S1 plan: ~$0.10/h, about $0.02 per run. Provisioning: ~3-5 minutes.
test.provider(
  "install and uninstall a site extension on a deployment slot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, extension } = yield* stack.deploy(slotProgram(true));
      expect(extension?.slot).toEqual("staging");
      const observed = yield* getExtension(group.resourceGroupName, app.siteName, first, "staging");
      expect(observed.name).toEqual(`${app.siteName}/staging/${first}`);
      // The production slot does not get the extension.
      expect(yield* extensionGone(group.resourceGroupName, app.siteName, first)).toEqual("gone");

      // Delete only the extension.
      yield* stack.deploy(slotProgram(false));
      expect(yield* extensionGone(group.resourceGroupName, app.siteName, first, "staging")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
