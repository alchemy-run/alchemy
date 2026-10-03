import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as vi from "@distilled.cloud/azure/vi";
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
    return yield* vi.GetPrivateEndpointConnection({
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
    Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
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
    const storage = yield* Azure.Storage.StorageAccount("Media", {
      resourceGroup: group.resourceGroupName,
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "IndexerIdentity",
      { resourceGroup: group.resourceGroupName },
    );
    const grant = yield* Azure.Authorization.RoleAssignment("IndexerStorage", {
      scope: storage.storageAccountId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataOwner,
      principalId: identity.principalId,
      principalType: "ServicePrincipal",
    });
    const account = yield* Azure.VideoIndexer.Account("Indexer", {
      resourceGroup: group.resourceGroupName,
      storageAccountId: storage.storageAccountId,
      storageUserAssignedIdentity: identity.identityId,
      tags: { grant: grant.principalId },
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
    const endpoint = yield* Azure.Network.PrivateEndpoint("IndexerPe", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: account.videoIndexerAccountId,
          groupIds: ["account"],
          requestMessage: "please approve",
        },
      ],
    });
    const connection = approval
      ? yield* Azure.VideoIndexer.PrivateEndpointConnection(
          "IndexerPeApproval",
          {
            resourceGroup: group.resourceGroupName,
            account: account.accountName,
            privateEndpointId: endpoint.privateEndpointId,
            status: approval.status,
            description: approval.description,
          },
        )
      : undefined;
    return { group, account, endpoint, connection };
  });

// Private endpoint ~$0.01/hour, a free Video Indexer account and an empty
// Standard_LRS storage account; ~10 minutes (account deletion is slow),
// well under $0.01.
test.provider(
  "approve and delete a video indexer private endpoint connection",
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

      // Platform probe: the Video Indexer RP answers any PUT on an
      // already-decided connection with a malformed `id`; ARM fails it with
      // HttpResponsePayloadAPISpecValidationFailed and keeps the old state,
      // so status/description updates cannot be applied. If this starts
      // succeeding, add an in-place update step to this test.
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const rejected = yield* vi
        .PrivateEndpointConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: rg,
          accountName: acct,
          privateEndpointConnectionName: name,
          properties: {
            privateLinkServiceConnectionState: {
              status: "Rejected",
              description: "use the shared endpoint",
            },
          },
        })
        .pipe(Effect.flip);
      expect(rejected._tag).toEqual(
        "HttpResponsePayloadAPISpecValidationFailed",
      );
      const unchanged = yield* getConnection(rg, acct, name);
      expect(
        unchanged.properties?.privateLinkServiceConnectionState.status,
      ).toEqual("Approved");

      // Removing the resource deletes the connection.
      yield* stack.deploy(program());
      expect(yield* connectionGone(rg, acct, name)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:videoindexer", "live"],
    timeout: 900_000,
  },
);
