import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
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

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetCluster({
      subscriptionId,
      resourceGroupName,
      clusterName,
    });
  });

const clusterGone = (resourceGroupName: string, clusterName: string) =>
  getCluster(resourceGroupName, clusterName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
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
      // Stream Analytics rejects resource group names over 80 characters.
      name: "alchemy-test-streamanalytics-cluster",
      location: "eastus",
    });
    const cluster = yield* Azure.StreamAnalytics.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      capacity: 36,
      tags: props.tags,
    });
    return { group, cluster };
  });

// Expensive: a 36-SU dedicated cluster bills ~$4-8/hour with an hourly
// minimum, and create + delete takes 30-90 minutes. Estimated ~$10/run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a dedicated cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(cluster.capacity).toEqual(36);
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.sku?.capacity).toEqual(36);
      expect(observed.tags?.env).toEqual("test");

      // In-place update: tags (capacity scaling would double the cost).
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.cluster.clusterResourceId).toEqual(
        cluster.clusterResourceId,
      );
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* clusterGone(group.resourceGroupName, cluster.clusterName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:streamanalytics", "live"],
    timeout: 900_000,
  },
);
