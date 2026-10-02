import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  vaultName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      vaultName,
      privateEndpointConnectionName,
    });
  });

const connectionGone = (rg: string, vaultName: string, name: string) =>
  getConnection(rg, vaultName, name).pipe(
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
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      softDeleteRetentionInDays: 7,
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
    const endpoint = yield* Azure.Network.PrivateEndpoint("VaultPe", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: vault.vaultId,
          groupIds: ["vault"],
          requestMessage: "please approve",
        },
      ],
    });
    const connection = approval
      ? yield* Azure.KeyVault.VaultPrivateEndpointConnection(
          "VaultPeApproval",
          {
            resourceGroup: group.resourceGroupName,
            vault: vault.vaultName,
            privateEndpointId: endpoint.privateEndpointId,
            status: approval.status,
            description: approval.description,
          },
        )
      : undefined;
    return { group, vault, endpoint, connection };
  });

// Private endpoint ~$0.01/hour; the vault has no hourly charge. The test
// runs for a few minutes (well under $0.01).
test.provider(
  "approve, reject, and delete a key vault private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ status: "Approved", description: "approved by alchemy" }),
      );
      const rg = created.group.resourceGroupName;
      const vaultName = created.vault.vaultName;
      const name = created.connection!.privateEndpointConnectionName;
      expect(created.connection!.status).toEqual("Approved");
      const observed = yield* getConnection(rg, vaultName, name);
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
      const reobserved = yield* getConnection(rg, vaultName, name);
      expect(
        reobserved.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Rejected");

      // Removing the resource deletes the connection.
      yield* stack.deploy(program());
      expect(yield* connectionGone(rg, vaultName, name)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 900_000,
  },
);
