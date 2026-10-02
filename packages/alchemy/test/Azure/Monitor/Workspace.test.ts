import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as monitoringservice from "@distilled.cloud/azure/monitoringservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (
  resourceGroupName: string,
  azureMonitorWorkspaceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* monitoringservice.GetAzureMonitorWorkspace({
      subscriptionId,
      resourceGroupName,
      azureMonitorWorkspaceName,
    });
  });

const workspaceGone = (resourceGroupName: string, name: string) =>
  getWorkspace(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  location?: string;
  publicNetworkAccess?: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.Monitor.Workspace("Metrics", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, workspace };
  });

// Free: an Azure Monitor workspace bills only ingested samples and queries.
test.provider(
  "create, update, replace, and delete an Azure Monitor workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const first = created.workspace;
      expect(first.workspaceName).toMatch(
        /^[a-zA-Z0-9][a-zA-Z0-9-]{2,42}[a-zA-Z0-9]$/,
      );
      expect(first.accountId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.prometheusQueryEndpoint).toMatch(/^https:\/\//);
      expect(first.dataCollectionRuleResourceId).toMatch(
        /Microsoft\.Insights\/dataCollectionRules/i,
      );
      const observed = yield* getWorkspace(rg, first.workspaceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Metrics");

      // In-place update: network access and tags.
      const updated = yield* stack.deploy(
        program({ publicNetworkAccess: "Disabled", tags: { env: "prod" } }),
      );
      expect(updated.workspace.workspaceName).toEqual(first.workspaceName);
      expect(updated.workspace.accountId).toEqual(first.accountId);
      const reobserved = yield* getWorkspace(rg, first.workspaceName);
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // Changing the location replaces the workspace.
      const moved = yield* stack.deploy(
        program({
          location: "westus2",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(moved.workspace.location.toLowerCase()).toEqual("westus2");
      expect(moved.workspace.accountId).not.toEqual(first.accountId);
      const replaced = yield* getWorkspace(rg, moved.workspace.workspaceName);
      expect(replaced.location.toLowerCase()).toEqual("westus2");

      yield* stack.destroy();
      expect(yield* workspaceGone(rg, moved.workspace.workspaceName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 900_000,
  },
);
