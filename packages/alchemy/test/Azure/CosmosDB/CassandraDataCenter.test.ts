import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, waitGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "eastus";

/**
 * Object ID of the "Azure Cosmos DB" service principal (app ID
 * `a232010e-820c-4083-83bb-3ace5fc29d0b`) in the test tenant.
 */
const cosmosPrincipal = process.env.AZURE_COSMOS_DB_SP_OBJECT_ID;

const NETWORK_CONTRIBUTOR = "4d97b98b-1d4f-4787-a291-c67834d212e7";

const getDataCenter = (
  resourceGroupName: string,
  clusterName: string,
  dataCenterName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetCassandraDataCenter({
      subscriptionId,
      resourceGroupName,
      clusterName,
      dataCenterName,
    }),
  );

const program = (nodeCount: number) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.41.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Nodes", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.41.1.0/24",
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
      delegatedManagementSubnetId: Output.map(
        Output.all(subnet.subnetId, grant.roleAssignmentId),
        ([subnetId]: [string, string]) => subnetId,
      ),
      initialCassandraAdminPassword: Redacted.make("Alchemy-Test-Pw-1234!"),
    });
    const dataCenter = yield* Azure.CosmosDB.CassandraDataCenter("Dc1", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      dataCenterLocation: LOCATION,
      delegatedSubnetId: subnet.subnetId,
      sku: "Standard_D8s_v5",
      nodeCount,
    });
    return { group, cluster, dataCenter };
  });

// Three Standard_D8s_v5 nodes (24 vCPUs) exceed the free trial's ~4
// regional vCPU quota. On a paid subscription: ~$3/hour for the nodes plus
// disks, 30-60 minutes for create + scale + delete (~$3-5 per run).
test.provider.skipIf(!runPaidOnly || !cosmosPrincipal)(
  "create, scale, and delete a Managed Cassandra data center",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, dataCenter } = yield* stack.deploy(program(3));
      expect(dataCenter.nodeCount).toEqual(3);
      const observed = yield* getDataCenter(
        group.resourceGroupName,
        cluster.clusterName,
        dataCenter.dataCenterName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.sku).toEqual("Standard_D8s_v5");

      // In-place update: scale out.
      const scaled = yield* stack.deploy(program(4));
      expect(scaled.dataCenter.dataCenterId).toEqual(dataCenter.dataCenterId);
      const rescaled = yield* getDataCenter(
        group.resourceGroupName,
        cluster.clusterName,
        dataCenter.dataCenterName,
      );
      expect(rescaled.properties?.nodeCount).toEqual(4);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDataCenter(
            group.resourceGroupName,
            cluster.clusterName,
            dataCenter.dataCenterName,
          ),
          120,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 6_000_000,
  },
);
