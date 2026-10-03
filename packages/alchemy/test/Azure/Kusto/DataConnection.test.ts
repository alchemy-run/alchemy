import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { devCluster, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
  dataConnectionName: string,
) =>
  Effect.gen(function* () {
    return yield* kusto.GetDataConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      databaseName,
      dataConnectionName,
    });
  });

const MAPPING = (name: string) =>
  `.create-or-alter table Events ingestion json mapping '${name}' '[{"column":"Name","path":"$.name","datatype":"string"}]'`;

const program = (props: { mappingRuleName: string }) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* devCluster();
    const database = yield* Azure.Kusto.Database("Database", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
    });
    const schema = yield* Azure.Kusto.Script("Schema", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      database: database.databaseName,
      content: [
        ".create-merge table Events (Name: string)",
        MAPPING("EventsMapping"),
        MAPPING("EventsMapping2"),
      ].join("\n"),
    });
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const hub = yield* Azure.EventHub.EventHub("Hub", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      partitionCount: 1,
    });
    const connection = yield* Azure.Kusto.DataConnection("Connection", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      // The table and mappings must exist before the connection.
      database: schema.database,
      kind: "EventHub",
      eventHubResourceId: hub.eventHubId,
      consumerGroup: "$Default",
      tableName: "Events",
      mappingRuleName: props.mappingRuleName,
      dataFormat: "JSON",
    });
    return { group, cluster, database, hub, connection };
  });

// Needs a Dev Kusto cluster (~$0.25/hour, 10-20 minutes to create, 5-10
// to delete) plus a Standard Event Hubs namespace (~$0.03/hour): ~$0.25
// per run, ~30 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Kusto Event Hub data connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, database, hub, connection } = yield* stack.deploy(
        program({ mappingRuleName: "EventsMapping" }),
      );
      const get = () =>
        getConnection(
          group.resourceGroupName,
          cluster.clusterName,
          database.databaseName,
          connection.dataConnectionName,
        );
      const observed = yield* get();
      expect(observed.kind).toEqual("EventHub");
      expect(observed.properties?.eventHubResourceId?.toLowerCase()).toEqual(
        hub.eventHubId.toLowerCase(),
      );
      expect(observed.properties?.mappingRuleName).toEqual("EventsMapping");

      // In place: switch the ingestion mapping.
      const updated = yield* stack.deploy(
        program({ mappingRuleName: "EventsMapping2" }),
      );
      expect(updated.connection.dataConnectionId).toEqual(
        connection.dataConnectionId,
      );
      expect((yield* get()).properties?.mappingRuleName).toEqual(
        "EventsMapping2",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(), 60)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
