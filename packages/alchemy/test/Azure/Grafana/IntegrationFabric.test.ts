import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dashboard from "@distilled.cloud/azure/dashboard";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getFabric = (
  resourceGroupName: string,
  workspaceName: string,
  integrationFabricName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* dashboard.GetIntegrationFabric({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      integrationFabricName,
    });
  });

const fabricGone = (
  resourceGroupName: string,
  workspaceName: string,
  integrationFabricName: string,
) =>
  getFabric(resourceGroupName, workspaceName, integrationFabricName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = (props: { scenarios: string[]; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus3",
    });
    const metrics = yield* Azure.Monitor.Workspace("Metrics", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
    });
    const workspace = yield* Azure.Grafana.Workspace("Grafana", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      identity: { type: "SystemAssigned" },
      azureMonitorWorkspaceIntegrations: [metrics.workspaceId],
    });
    const fabric = yield* Azure.Grafana.IntegrationFabric("Fabric", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      dataSourceResourceId: metrics.workspaceId,
      scenarios: props.scenarios,
      tags: props.tags,
    });
    return { group, workspace, fabric };
  });

// Needs an Azure Monitor workspace and a Standard Grafana workspace (~3 min
// create / ~10 min delete): a few cents per run, but ~15 min end to end.
// Azure only accepts target types NoneType/BundledAMW/SreAgent, so the
// fabric has no target and uses the AMW data source with `aks`/`istio`.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Grafana integration fabric",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, fabric } = yield* stack.deploy(
        program({ scenarios: ["aks"], tags: { env: "test" } }),
      );
      expect(fabric.scenarios).toEqual(["aks"]);
      const observed = yield* getFabric(
        group.resourceGroupName,
        workspace.workspaceName,
        fabric.integrationFabricName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Fabric");

      // In-place updates: scenarios and tags.
      const updated = yield* stack.deploy(
        program({
          scenarios: ["aks", "istio"],
          tags: { env: "prod" },
        }),
      );
      expect(updated.fabric.integrationFabricName).toEqual(
        fabric.integrationFabricName,
      );
      const reobserved = yield* getFabric(
        group.resourceGroupName,
        workspace.workspaceName,
        fabric.integrationFabricName,
      );
      expect([...(reobserved.properties?.scenarios ?? [])].sort()).toEqual([
        "aks",
        "istio",
      ]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* fabricGone(
          group.resourceGroupName,
          workspace.workspaceName,
          fabric.integrationFabricName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:grafana", "live"],
    timeout: 2_400_000,
  },
);
