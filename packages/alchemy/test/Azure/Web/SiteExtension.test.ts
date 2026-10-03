import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getExtension = (
  resourceGroupName: string,
  name: string,
  siteExtensionId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppSiteExtension({
      subscriptionId,
      resourceGroupName,
      name,
      siteExtensionId,
    });
  });

const extensionGone = (
  resourceGroupName: string,
  name: string,
  siteExtensionId: string,
) =>
  getExtension(resourceGroupName, name, siteExtensionId).pipe(
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
      const observed = yield* getExtension(
        group.resourceGroupName,
        app.siteName,
        first,
      );
      expect(observed.name).toEqual(`${app.siteName}/${first}`);

      // Replacement: another extension.
      const replaced = yield* stack.deploy(program(second));
      expect(replaced.extension!.extensionId).toEqual(second);
      const installed = yield* getExtension(
        group.resourceGroupName,
        app.siteName,
        second,
      );
      expect(installed.name).toEqual(`${app.siteName}/${second}`);
      expect(
        yield* extensionGone(group.resourceGroupName, app.siteName, first),
      ).toEqual("gone");

      // Delete only the extension.
      yield* stack.deploy(program(undefined));
      expect(
        yield* extensionGone(group.resourceGroupName, app.siteName, second),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
