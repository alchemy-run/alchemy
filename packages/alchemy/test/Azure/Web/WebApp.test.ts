import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const where = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, name };
  });

const getApp = (resourceGroupName: string, name: string) =>
  where(resourceGroupName, name).pipe(Effect.flatMap(web.GetWebApp));

const appGone = (resourceGroupName: string, name: string) =>
  getApp(resourceGroupName, name).pipe(
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
  os: "linux" | "windows";
  siteConfig: Azure.Web.SiteConfig;
  appSettings: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // The free trial has F1 quota in centralus but not in eastus. Both plans
    // stay deployed so the OS replacement never removes a live dependency.
    const linuxPlan = yield* Azure.Web.AppServicePlan("LinuxPlan", {
      resourceGroup: group.resourceGroupName,
      location: "centralus",
      sku: "F1",
      os: "linux",
    });
    const windowsPlan = yield* Azure.Web.AppServicePlan("WindowsPlan", {
      resourceGroup: group.resourceGroupName,
      location: "centralus",
      sku: "F1",
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId:
        props.os === "linux"
          ? linuxPlan.appServicePlanId
          : windowsPlan.appServicePlanId,
      os: props.os,
      siteConfig: props.siteConfig,
      appSettings: props.appSettings,
      tags: props.tags,
    });
    return { group, app };
  });

// Cost: $0 (F1 Free plans). Provisioning: ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a web app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app } = yield* stack.deploy(
        program({
          os: "linux",
          siteConfig: { linuxFxVersion: "NODE|20-lts", alwaysOn: false },
          appSettings: { GREETING: "hello" },
          tags: { env: "test" },
        }),
      );
      expect(app.kind).toEqual("app,linux");
      expect(app.os).toEqual("linux");
      expect(app.defaultHostName).toEqual(`${app.siteName}.azurewebsites.net`);
      expect(app.state).toEqual("Running");

      const observed = yield* getApp(group.resourceGroupName, app.siteName);
      expect(observed.properties?.httpsOnly).toEqual(true);
      expect(observed.properties?.reserved).toEqual(true);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Site");
      const config = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.GetWebAppConfiguration),
      );
      expect(config.properties?.linuxFxVersion).toEqual("NODE|20-lts");
      const settings = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.ListWebAppApplicationSettings),
      );
      expect(settings.properties?.GREETING).toEqual("hello");

      // The default host serves the platform's placeholder page.
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(app.url).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(res.status),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(response.status).toEqual(200);

      // In-place update: site config, app settings, and tags.
      const updated = yield* stack.deploy(
        program({
          os: "linux",
          siteConfig: {
            linuxFxVersion: "NODE|22-lts",
            alwaysOn: false,
            http20Enabled: true,
          },
          appSettings: { GREETING: "bonjour", MODE: "prod" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.app.siteName).toEqual(app.siteName);
      const reconfig = yield* where(group.resourceGroupName, app.siteName).pipe(
        Effect.flatMap(web.GetWebAppConfiguration),
      );
      expect(reconfig.properties?.linuxFxVersion).toEqual("NODE|22-lts");
      expect(reconfig.properties?.http20Enabled).toEqual(true);
      const resettings = yield* where(
        group.resourceGroupName,
        app.siteName,
      ).pipe(Effect.flatMap(web.ListWebAppApplicationSettings));
      expect(resettings.properties).toEqual({
        GREETING: "bonjour",
        MODE: "prod",
      });
      const retagged = yield* getApp(group.resourceGroupName, app.siteName);
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: Linux -> Windows cannot change in place.
      const replaced = yield* stack.deploy(
        program({
          os: "windows",
          siteConfig: { alwaysOn: false },
          appSettings: { GREETING: "bonjour", MODE: "prod" },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.app.siteName).not.toEqual(app.siteName);
      expect(replaced.app.kind).toEqual("app");
      const windows = yield* getApp(
        group.resourceGroupName,
        replaced.app.siteName,
      );
      expect(windows.properties?.reserved ?? false).toEqual(false);
      expect(yield* appGone(group.resourceGroupName, app.siteName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* appGone(group.resourceGroupName, replaced.app.siteName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
