import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** The production environment every static site has. */
const ENVIRONMENT = "default";

const appSettings = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const settings = yield* web.ListStaticSiteStaticSiteBuildAppSettings({
      subscriptionId,
      resourceGroupName,
      name,
      environmentName: ENVIRONMENT,
    });
    return settings.properties ?? {};
  });

const program = (settings: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const site = yield* Azure.Web.StaticSite("Site", {
      resourceGroup: group.resourceGroupName,
      location: "eastus2",
      sku: "Free",
    });
    const envSettings =
      settings === undefined
        ? undefined
        : yield* Azure.Web.StaticSiteEnvironmentSettings("EnvSettings", {
            resourceGroup: group.resourceGroupName,
            staticSiteName: site.staticSiteName,
            environmentName: ENVIRONMENT,
            appSettings: settings,
          });
    return { group, site, envSettings };
  });

// Cost: $0 (Free static site). Provisioning: ~1 minute.
test.provider(
  "set, update, and clear the app settings of a static site environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site, envSettings } = yield* stack.deploy(program({ API_URL: "v1" }));
      expect(envSettings?.appSettingNames).toEqual(["API_URL"]);
      expect(yield* appSettings(group.resourceGroupName, site.staticSiteName)).toEqual({
        API_URL: "v1",
      });

      // In-place update: replace the map.
      yield* stack.deploy(program({ API_URL: "v2", MODE: "preview" }));
      expect(yield* appSettings(group.resourceGroupName, site.staticSiteName)).toEqual({
        API_URL: "v2",
        MODE: "preview",
      });

      // Removing the resource clears the environment's settings.
      yield* stack.deploy(program(undefined));
      expect(yield* appSettings(group.resourceGroupName, site.staticSiteName)).toEqual({});

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
