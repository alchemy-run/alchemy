import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { devCluster, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDatabase = (
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    return yield* kusto.GetDatabase({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      databaseName,
    });
  });

const program = (props: {
  name?: string;
  softDeletePeriod: string;
  hotCachePeriod?: string;
}) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* devCluster();
    const database = yield* Azure.Kusto.Database("Database", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      name: props.name,
      softDeletePeriod: props.softDeletePeriod,
      hotCachePeriod: props.hotCachePeriod,
    });
    return { group, cluster, database };
  });

// Needs a Dev Kusto cluster (~$0.25/hour, 10-20 minutes to create, 5-10
// to delete): ~$0.20 per run, ~30 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a Kusto database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, database } = yield* stack.deploy(
        program({ softDeletePeriod: "P7D" }),
      );
      const get = (name: string) =>
        getDatabase(group.resourceGroupName, cluster.clusterName, name);
      expect(database.softDeletePeriod).toEqual("P7D");
      const observed = yield* get(database.databaseName);
      expect(observed.kind).toEqual("ReadWrite");
      expect(observed.properties?.softDeletePeriod).toEqual("P7D");

      // In place: longer retention and a hot cache.
      const updated = yield* stack.deploy(
        program({ softDeletePeriod: "P30D", hotCachePeriod: "P1D" }),
      );
      expect(updated.database.databaseId).toEqual(database.databaseId);
      const reobserved = yield* get(database.databaseName);
      expect(reobserved.properties?.softDeletePeriod).toEqual("P30D");
      expect(reobserved.properties?.hotCachePeriod).toEqual("P1D");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-kusto-db-renamed",
          softDeletePeriod: "P30D",
          hotCachePeriod: "P1D",
        }),
      );
      expect(replaced.database.databaseName).toEqual(
        "alchemy-kusto-db-renamed",
      );
      expect(
        (yield* get("alchemy-kusto-db-renamed")).properties?.softDeletePeriod,
      ).toEqual("P30D");
      expect(yield* waitGone(get(database.databaseName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          Effect.gen(function* () {
            return yield* kusto.GetCluster({
              subscriptionId: yield* subscription,
              resourceGroupName: group.resourceGroupName,
              clusterName: cluster.clusterName,
            });
          }),
          60,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
