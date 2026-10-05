import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* kusto.GetCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
    });
  });

const program = (props: {
  enableStreamingIngest: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.Kusto.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      enableStreamingIngest: props.enableStreamingIngest,
      tags: props.tags,
    });
    return { group, cluster };
  });

// Dev(No SLA)_Standard_E2a_v4 cluster (~$0.25/hour): ~$0.15 per run, but
// 10-20 minutes to create and 5-10 minutes to delete.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Kusto cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({ enableStreamingIngest: false, tags: { env: "test" } }),
      );
      expect(cluster.state).toEqual("Running");
      expect(cluster.skuName).toEqual("Dev(No SLA)_Standard_E2a_v4");
      expect(cluster.uri).toContain(".kusto.windows.net");
      expect(cluster.tags).toEqual({ env: "test" });
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.properties?.enableStreamingIngest).toEqual(false);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cluster");

      // In place: enable streaming ingestion and change tags.
      const updated = yield* stack.deploy(
        program({ enableStreamingIngest: true, tags: { env: "prod" } }),
      );
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      expect(updated.cluster.tags).toEqual({ env: "prod" });
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.properties?.enableStreamingIngest).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(group.resourceGroupName, cluster.clusterName),
          60,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);

// Ungated probe (free): a missing cluster reads as the typed not-found
// the provider maps to "absent".
test.provider(
  "a missing Kusto cluster reads as a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* getCluster(
        group.resourceGroupName,
        "alchemymissingkusto",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
