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

const getContainer = (
  resourceGroupName: string,
  name: string,
  containerName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppSiteContainer({
      subscriptionId,
      resourceGroupName,
      name,
      containerName,
    });
  });

const containerGone = (
  resourceGroupName: string,
  name: string,
  containerName: string,
) =>
  getContainer(resourceGroupName, name, containerName).pipe(
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

const program = (sidecar: {
  name: string;
  startUpCommand?: string;
  environmentVariables?: { name: string; value: string }[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // The free trial has F1 quota in centralus but not in eastus.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "centralus",
      sku: "F1",
      os: "linux",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      siteConfig: { linuxFxVersion: "SITECONTAINERS", alwaysOn: false },
      appSettings: { SIDECAR_GREETING: "hello" },
    });
    const main = yield* Azure.Web.SiteContainer("Main", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      image: "mcr.microsoft.com/appsvc/staticsite:latest",
      targetPort: "80",
      isMain: true,
    });
    const side = yield* Azure.Web.SiteContainer("Sidecar", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: sidecar.name,
      image: "mcr.microsoft.com/k8se/quickstart:latest",
      targetPort: "8080",
      isMain: false,
      startUpCommand: sidecar.startUpCommand,
      environmentVariables: sidecar.environmentVariables,
    });
    return { group, app, main, side };
  });

// Cost: $0 (F1 Free plan). Provisioning: ~1-2 minutes.
test.provider(
  "create, update, replace, and delete site containers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, main, side } = yield* stack.deploy(
        program({ name: "sidecar-a" }),
      );
      expect(main.isMain).toEqual(true);
      expect(side.containerName).toEqual("sidecar-a");
      const observedMain = yield* getContainer(
        group.resourceGroupName,
        app.siteName,
        main.containerName,
      );
      expect(observedMain.properties?.image).toEqual(
        "mcr.microsoft.com/appsvc/staticsite:latest",
      );
      expect(observedMain.properties?.isMain).toEqual(true);
      expect(observedMain.properties?.targetPort).toEqual("80");

      // In-place update: startup command and app-setting references.
      const updated = yield* stack.deploy(
        program({
          name: "sidecar-a",
          startUpCommand: "/app/start.sh",
          environmentVariables: [
            { name: "GREETING", value: "SIDECAR_GREETING" },
          ],
        }),
      );
      expect(updated.side.siteContainerId).toEqual(side.siteContainerId);
      const observedSide = yield* getContainer(
        group.resourceGroupName,
        app.siteName,
        "sidecar-a",
      );
      expect(observedSide.properties?.startUpCommand).toEqual("/app/start.sh");
      expect(observedSide.properties?.environmentVariables).toEqual([
        { name: "GREETING", value: "SIDECAR_GREETING" },
      ]);

      // Replacement: the container name cannot change in place.
      const replaced = yield* stack.deploy(program({ name: "sidecar-b" }));
      expect(replaced.side.containerName).toEqual("sidecar-b");
      const renamed = yield* getContainer(
        group.resourceGroupName,
        app.siteName,
        "sidecar-b",
      );
      expect(renamed.properties?.isMain).toEqual(false);
      expect(
        yield* containerGone(
          group.resourceGroupName,
          app.siteName,
          "sidecar-a",
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* containerGone(
          group.resourceGroupName,
          app.siteName,
          main.containerName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
