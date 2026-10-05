import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (
  resourceGroupName: string,
  clusterName: string,
  attachedDatabaseConfigurationName: string,
) =>
  Effect.gen(function* () {
    return yield* kusto.GetAttachedDatabaseConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      attachedDatabaseConfigurationName,
    });
  });

const program = (props: { kind: "Union" | "Replace" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const leader = yield* Azure.Kusto.Cluster("Leader", {
      resourceGroup: group.resourceGroupName,
    });
    const follower = yield* Azure.Kusto.Cluster("Follower", {
      resourceGroup: group.resourceGroupName,
    });
    const database = yield* Azure.Kusto.Database("Database", {
      resourceGroup: group.resourceGroupName,
      cluster: leader.clusterName,
    });
    const config = yield* Azure.Kusto.AttachedDatabaseConfiguration("Follow", {
      resourceGroup: group.resourceGroupName,
      cluster: follower.clusterName,
      leaderClusterId: leader.clusterId,
      databaseName: database.databaseName,
      defaultPrincipalsModificationKind: props.kind,
    });
    return { group, leader, follower, database, config };
  });

// Needs TWO Dev Kusto clusters (~$0.50/hour together, 10-20 minutes to
// create, 5-10 to delete): ~$0.40 per run, 30+ minutes.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a Kusto attached database configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, follower, database, config } = yield* stack.deploy(
        program({ kind: "Union" }),
      );
      const get = () =>
        getConfiguration(
          group.resourceGroupName,
          follower.clusterName,
          config.attachedDatabaseConfigurationName,
        );
      const observed = yield* get();
      expect(observed.properties?.databaseName).toEqual(database.databaseName);
      expect(observed.properties?.defaultPrincipalsModificationKind).toEqual(
        "Union",
      );
      expect(config.attachedDatabaseNames).toContain(database.databaseName);

      // Replacement (delete first): Azure cannot update the principals
      // modification kind of an attached configuration.
      const replaced = yield* stack.deploy(program({ kind: "Replace" }));
      expect(replaced.config.attachedDatabaseConfigurationId).not.toEqual(
        config.attachedDatabaseConfigurationId,
      );
      const getReplaced = () =>
        getConfiguration(
          group.resourceGroupName,
          follower.clusterName,
          replaced.config.attachedDatabaseConfigurationName,
        );
      expect(
        (yield* getReplaced()).properties?.defaultPrincipalsModificationKind,
      ).toEqual("Replace");
      expect(yield* waitGone(get(), 60)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getReplaced(), 60)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
