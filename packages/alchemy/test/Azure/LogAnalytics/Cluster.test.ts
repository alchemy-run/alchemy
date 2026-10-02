import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetCluster({
      subscriptionId,
      resourceGroupName,
      clusterName,
    });
  });

const clusterGone = (resourceGroupName: string, clusterName: string) =>
  getCluster(resourceGroupName, clusterName).pipe(
    Effect.map((cluster) =>
      cluster.properties?.provisioningState === "Deleting"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 40,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.LogAnalytics.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      capacity: 100,
      tags: props.tags,
    });
    return { group, cluster };
  });

// A dedicated cluster bills its 100 GB/day minimum commitment (~$200+/day)
// from creation with a 31-day minimum (thousands of USD), and provisioning
// takes up to two hours — far beyond the free-trial credit. It only runs
// with both AZURE_TEST_EXPENSIVE=1 and AZURE_TEST_LOG_ANALYTICS_CLUSTER=1
// on an entitled subscription.
test.provider.skipIf(
  !runExpensive || !process.env.AZURE_TEST_LOG_ANALYTICS_CLUSTER,
)(
  "create, update, and delete a Log Analytics dedicated cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const name = created.cluster.clusterName;
      expect(created.cluster.capacity).toEqual(100);
      const observed = yield* getCluster(rg, name);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place tag update.
      yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect((yield* getCluster(rg, name)).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* clusterGone(rg, name)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
