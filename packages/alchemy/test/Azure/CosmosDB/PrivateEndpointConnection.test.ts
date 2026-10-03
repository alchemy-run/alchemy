import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  COSMOS_LOCATION,
  logLevel,
  subscriptionId,
  waitGone,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  accountName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      accountName,
      privateEndpointConnectionName,
    }),
  );

const program = (approval?: {
  status: "Approved" | "Rejected";
  description: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless"],
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("AccountSql", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: account.accountId,
          groupIds: ["Sql"],
          requestMessage: "please approve",
        },
      ],
    });
    const connection = approval
      ? yield* Azure.CosmosDB.PrivateEndpointConnection("AccountSqlApproval", {
          resourceGroup: group.resourceGroupName,
          databaseAccount: account.accountName,
          privateEndpointId: endpoint.privateEndpointId,
          status: approval.status,
          description: approval.description,
        })
      : undefined;
    return { group, account, endpoint, connection };
  });

// Serverless account (free while idle) + a private endpoint (~$0.01/hour);
// the run takes ~10-15 min, well under $0.01.
test.provider(
  "approve, reject, and delete a Cosmos DB private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ status: "Approved", description: "approved by alchemy" }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.accountName;
      const name = created.connection!.privateEndpointConnectionName;
      expect(created.connection!.status).toEqual("Approved");
      expect(created.connection!.groupId).toEqual("Sql");
      const observed = yield* getConnection(rg, acct, name);
      expect(
        observed.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("approved by alchemy");
      expect(observed.properties?.privateEndpoint?.id?.toLowerCase()).toEqual(
        created.endpoint.privateEndpointId.toLowerCase(),
      );

      // In-place update: reject the connection with a reason.
      const updated = yield* stack.deploy(
        program({ status: "Rejected", description: "use the shared endpoint" }),
      );
      expect(updated.connection!.privateEndpointConnectionName).toEqual(name);
      expect(updated.connection!.status).toEqual("Rejected");
      const reobserved = yield* getConnection(rg, acct, name);
      expect(
        reobserved.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Rejected");
      expect(
        reobserved.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("use the shared endpoint");

      // Removing the resource deletes the connection.
      yield* stack.deploy(program());
      expect(yield* waitGone(getConnection(rg, acct, name))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          Effect.flatMap(subscriptionId, (subscriptionId) =>
            cosmos.GetDatabaseAccount({
              subscriptionId,
              resourceGroupName: rg,
              accountName: acct,
            }),
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 900_000,
  },
);
