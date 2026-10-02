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

const getSourceControl = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppSourceControl({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

/** "gone" once the app reports no repository (or the app itself is gone). */
const sourceControlGone = (resourceGroupName: string, name: string) =>
  getSourceControl(resourceGroupName, name).pipe(
    Effect.map((observed) =>
      observed.properties?.repoUrl ? ("found" as const) : ("gone" as const),
    ),
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

const program = (source: { repoUrl: string; branch: string } | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Flex Consumption has no Kudu source control and the trial has no
    // Consumption (Y1) or Basic quota; F1 quota exists only in centralus.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "centralus",
      sku: "F1",
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "windows",
      siteConfig: { alwaysOn: false },
    });
    if (source !== undefined) {
      yield* Azure.Web.SourceControl("Source", {
        resourceGroup: group.resourceGroupName,
        siteName: app.siteName,
        repoUrl: source.repoUrl,
        branch: source.branch,
      });
    }
    return { group, app };
  });

// Cost: $0 (F1 Free plan). Provisioning: ~2-4 minutes (Kudu clones the
// repository on each change).
test.provider(
  "connect, update, and disconnect source control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app } = yield* stack.deploy(
        program({
          repoUrl: "https://github.com/Azure-Samples/html-docs-hello-world",
          branch: "master",
        }),
      );
      const observed = yield* getSourceControl(
        group.resourceGroupName,
        app.siteName,
      );
      expect(observed.properties?.repoUrl).toEqual(
        "https://github.com/Azure-Samples/html-docs-hello-world",
      );
      expect(observed.properties?.branch).toEqual("master");
      expect(observed.properties?.isManualIntegration).toEqual(true);

      // In-place update: another repository.
      yield* stack.deploy(
        program({
          repoUrl: "https://github.com/Azure-Samples/nodejs-docs-hello-world",
          branch: "main",
        }),
      );
      const updated = yield* getSourceControl(
        group.resourceGroupName,
        app.siteName,
      );
      expect(updated.properties?.repoUrl).toEqual(
        "https://github.com/Azure-Samples/nodejs-docs-hello-world",
      );
      expect(updated.properties?.branch).toEqual("main");

      // Delete: removing the resource disconnects the repository.
      yield* stack.deploy(program(undefined));
      expect(
        yield* sourceControlGone(group.resourceGroupName, app.siteName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
