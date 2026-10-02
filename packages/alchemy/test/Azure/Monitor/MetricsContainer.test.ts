import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as monitoringservice from "@distilled.cloud/azure/monitoringservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getContainer = (
  resourceGroupName: string,
  azureMonitorWorkspaceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* monitoringservice.GetMetricsContainer({
      subscriptionId,
      resourceGroupName,
      azureMonitorWorkspaceName,
      metricsContainerName: "default",
    });
  });

const containerGone = (resourceGroupName: string, workspaceName: string) =>
  getContainer(resourceGroupName, workspaceName).pipe(
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

const program = (props: { workspace: string; version?: "1.0" | "2.0" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Two workspaces stay deployed so the replacement step never removes
    // the old parent in the same deploy.
    const a = yield* Azure.Monitor.Workspace("MetricsA", {
      resourceGroup: group.resourceGroupName,
    });
    const b = yield* Azure.Monitor.Workspace("MetricsB", {
      resourceGroup: group.resourceGroupName,
    });
    const parent = props.workspace === "A" ? a : b;
    const container = yield* Azure.Monitor.MetricsContainer("Container", {
      resourceGroup: parent.resourceGroup,
      workspaceName: parent.workspaceName,
      version: props.version,
    });
    return { group, a, b, container };
  });

// Free: Azure Monitor workspaces bill only ingested samples and queries.
test.provider(
  "create, update, replace, and delete an Azure Monitor metrics container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ workspace: "A", version: "1.0" }),
      );
      const rg = created.group.resourceGroupName;
      expect(created.container.metricsContainerName).toEqual("default");
      expect(created.container.version).toEqual("1.0");
      expect(created.container.metricsContainerId).toMatch(
        /metricsContainers\/default$/i,
      );
      const observed = yield* getContainer(rg, created.a.workspaceName);
      expect(observed.properties?.version).toEqual("1.0");

      // In-place update of the version.
      const updated = yield* stack.deploy(
        program({ workspace: "A", version: "2.0" }),
      );
      expect(updated.container.version).toEqual("2.0");
      const reobserved = yield* getContainer(rg, created.a.workspaceName);
      expect(reobserved.properties?.version).toEqual("2.0");

      // Back to 1.0, then move to the other workspace (replacement): the
      // old workspace's container is restored to the default version.
      yield* stack.deploy(program({ workspace: "A", version: "1.0" }));
      const moved = yield* stack.deploy(
        program({ workspace: "B", version: "1.0" }),
      );
      expect(moved.container.workspaceName).toEqual(moved.b.workspaceName);
      const onB = yield* getContainer(rg, moved.b.workspaceName);
      expect(onB.properties?.version).toEqual("1.0");
      const onA = yield* getContainer(rg, moved.a.workspaceName);
      expect(onA.properties?.version).toEqual("2.0");

      yield* stack.destroy();
      expect(yield* containerGone(rg, moved.b.workspaceName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 900_000,
  },
);
