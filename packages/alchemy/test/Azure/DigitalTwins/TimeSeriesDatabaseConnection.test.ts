import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as digitaltwins from "@distilled.cloud/azure/digitaltwins";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const EVENT_HUBS_DATA_OWNER = "f526a384-b230-433a-b45c-95f59c4a2dec";

const getConnection = (
  resourceGroupName: string,
  resourceName: string,
  timeSeriesDatabaseConnectionName: string,
) =>
  Effect.gen(function* () {
    return yield* digitaltwins.GetTimeSeriesDatabaseConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      timeSeriesDatabaseConnectionName,
    });
  });

const program = (props: { table: string; cleanup: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // A user-assigned identity: Kusto principal assignments need its
    // client ID, which a system-assigned identity does not expose.
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName },
    );
    const instance = yield* Azure.DigitalTwins.Instance("Twins", {
      resourceGroup: group.resourceGroupName,
      identity: {
        type: "UserAssigned",
        userAssignedIdentities: [identity.identityId],
      },
    });
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const hub = yield* Azure.EventHub.EventHub("History", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      partitionCount: 1,
    });
    const cluster = yield* Azure.Kusto.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
    });
    const database = yield* Azure.Kusto.Database("Database", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
    });
    const hubRole = yield* Azure.Authorization.RoleAssignment("HubOwner", {
      scope: namespace.namespaceId,
      roleDefinitionId: EVENT_HUBS_DATA_OWNER,
      principalId: identity.principalId,
      principalType: "ServicePrincipal",
    });
    const clusterRole = yield* Azure.Authorization.RoleAssignment(
      "ClusterContributor",
      {
        scope: cluster.clusterId,
        roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
        principalId: identity.principalId,
        principalType: "ServicePrincipal",
      },
    );
    const dbAdmin = yield* Azure.Kusto.DatabasePrincipalAssignment("DbAdmin", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      database: database.databaseName,
      principalId: identity.clientId,
      principalType: "App",
      tenantId: identity.tenantId,
      role: "Admin",
    });
    const connection = yield* Azure.DigitalTwins.TimeSeriesDatabaseConnection(
      "History",
      {
        resourceGroup: group.resourceGroupName,
        // Wait for the grants: the connection validates access on create.
        instance: Output.map(
          Output.all(
            instance.instanceName,
            hubRole.roleAssignmentId,
            clusterRole.roleAssignmentId,
            dbAdmin.principalAssignmentName,
          ),
          ([name]: [string, string, string, string]) => name,
        ),
        adxResourceId: cluster.clusterId,
        adxEndpointUri: cluster.uri,
        adxDatabaseName: database.databaseName,
        adxTableName: props.table,
        eventHubNamespaceResourceId: namespace.namespaceId,
        eventHubEndpointUri: Output.interpolate`sb://${namespace.namespaceName}.servicebus.windows.net`,
        eventHubEntityPath: hub.eventHubName,
        identity: {
          type: "UserAssigned",
          userAssignedIdentity: identity.identityId,
        },
        cleanupConnectionArtifacts: props.cleanup,
      },
    );
    return { group, instance, connection };
  });

// Needs a Dev Kusto cluster (~$0.25/hour, 10-20 minutes to create, 5-10 to
// delete) and a Standard Event Hubs namespace (~$0.03/hour): ~$0.25 per
// run, ~40 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a time series database connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, connection } = yield* stack.deploy(
        program({ table: "AdtPropertyEvents", cleanup: true }),
      );
      const get = (name: string) =>
        getConnection(group.resourceGroupName, instance.instanceName, name);
      expect(connection.provisioningState).toEqual("Succeeded");
      const observed = yield* get(connection.connectionName);
      expect(observed.properties?.connectionType).toEqual("AzureDataExplorer");
      expect(observed.properties?.adxTableName).toEqual("AdtPropertyEvents");

      // In-place: the delete-time cleanup flag is local state only.
      const updated = yield* stack.deploy(
        program({ table: "AdtPropertyEvents", cleanup: false }),
      );
      expect(updated.connection.connectionId).toEqual(connection.connectionId);
      expect(updated.connection.cleanupConnectionArtifacts).toEqual(false);

      // Replacement: every connection property is immutable.
      const replaced = yield* stack.deploy(
        program({ table: "TwinHistory", cleanup: true }),
      );
      expect(replaced.connection.connectionName).not.toEqual(
        connection.connectionName,
      );
      const replacedObserved = yield* get(replaced.connection.connectionName);
      expect(replacedObserved.properties?.adxTableName).toEqual("TwinHistory");
      expect(yield* waitGone(get(connection.connectionName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.connection.connectionName), 60),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
