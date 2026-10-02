import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  accountName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      accountName,
      privateEndpointConnectionName,
    });
  });

const connectionGone = (
  resourceGroupName: string,
  accountName: string,
  name: string,
) =>
  getConnection(resourceGroupName, accountName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (approval?: {
  status: "Approved" | "Rejected";
  description: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("FilesBlob", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: account.storageAccountId,
          groupIds: ["blob"],
          requestMessage: "please approve",
        },
      ],
    });
    const connection = approval
      ? yield* Azure.Storage.PrivateEndpointConnection("FilesBlobApproval", {
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          privateEndpointId: endpoint.privateEndpointId,
          status: approval.status,
          description: approval.description,
        })
      : undefined;
    return { group, account, endpoint, connection };
  });

// Private endpoint ~$0.01/hour + an empty Standard_LRS account; the test
// runs for a few minutes (well under $0.01).
test.provider(
  "approve, reject, and delete a private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ status: "Approved", description: "approved by alchemy" }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const name = created.connection!.privateEndpointConnectionName;
      expect(created.connection!.status).toEqual("Approved");
      const observed = yield* getConnection(rg, acct, name);
      expect(
        observed.properties?.privateLinkServiceConnectionState.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState.description,
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
        reobserved.properties?.privateLinkServiceConnectionState.status,
      ).toEqual("Rejected");
      expect(
        reobserved.properties?.privateLinkServiceConnectionState.description,
      ).toEqual("use the shared endpoint");

      // Removing the resource deletes the connection.
      yield* stack.deploy(program());
      expect(yield* connectionGone(rg, acct, name)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
