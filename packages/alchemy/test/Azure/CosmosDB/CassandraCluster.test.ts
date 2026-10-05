import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, waitGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "eastus";

/**
 * Object ID of the "Azure Cosmos DB" service principal (app ID
 * `a232010e-820c-4083-83bb-3ace5fc29d0b`) in the test tenant:
 * `az ad sp show --id a232010e-820c-4083-83bb-3ace5fc29d0b --query id -o tsv`.
 */
const cosmosPrincipal = process.env.AZURE_COSMOS_DB_SP_OBJECT_ID;

const NETWORK_CONTRIBUTOR = "4d97b98b-1d4f-4787-a291-c67834d212e7";

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetCassandraCluster({
      subscriptionId,
      resourceGroupName,
      clusterName,
    }),
  );

const clusterProgram = (props: {
  tags: Record<string, string>;
  repairEnabled: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.40.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Nodes", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.40.1.0/24",
      // Managed Cassandra needs outbound access to Azure services; new
      // subnets default to private, which fails cluster creation ~30
      // minutes in with "connection failure".
      defaultOutboundAccess: true,
    });
    const grant = yield* Azure.Authorization.RoleAssignment("CosmosNetwork", {
      scope: vnet.virtualNetworkId,
      roleDefinitionId: NETWORK_CONTRIBUTOR,
      principalId: cosmosPrincipal!,
      principalType: "ServicePrincipal",
    });
    const cluster = yield* Azure.CosmosDB.CassandraCluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      // Ordered after the grant: Cosmos validates its access to the subnet.
      delegatedManagementSubnetId: Output.map(
        Output.all(subnet.subnetId, grant.roleAssignmentId),
        ([subnetId]: [string, string]) => subnetId,
      ),
      initialCassandraAdminPassword: Redacted.make("Alchemy-Test-Pw-1234!"),
      repairEnabled: props.repairEnabled,
      tags: props.tags,
    });
    return { group, vnet, subnet, grant, cluster };
  });

// The management plane alone has no VM cost, but creation and deletion take
// 10-40 minutes, over the ~10 minute budget for ungated tests. Needs the
// "Azure Cosmos DB" service principal object ID in
// AZURE_COSMOS_DB_SP_OBJECT_ID.
test.provider.skipIf(!runExpensive || !cosmosPrincipal)(
  "create, update, and delete a Managed Cassandra cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, subnet, cluster } = yield* stack.deploy(
        clusterProgram({ tags: { env: "test" }, repairEnabled: true }),
      );
      expect(cluster.delegatedManagementSubnetId.toLowerCase()).toEqual(
        subnet.subnetId.toLowerCase(),
      );
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place update: tags and repair setting.
      const updated = yield* stack.deploy(
        clusterProgram({ tags: { env: "prod" }, repairEnabled: false }),
      );
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.repairEnabled).toEqual(false);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCluster(group.resourceGroupName, cluster.clusterName),
          120,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 10_800_000,
  },
);
