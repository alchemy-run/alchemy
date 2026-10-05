import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  hsmName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetMHSMPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      name: hsmName,
      privateEndpointConnectionName,
    });
  });

const connectionGone = (rg: string, hsmName: string, name: string) =>
  getConnection(rg, hsmName, name).pipe(
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
    const admin = yield* Azure.ManagedIdentity.UserAssignedIdentity("Admin", {
      resourceGroup: group.resourceGroupName,
    });
    const hsm = yield* Azure.KeyVault.ManagedHsm("Hsm", {
      resourceGroup: group.resourceGroupName,
      initialAdminObjectIds: [admin.principalId],
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
    const endpoint = yield* Azure.Network.PrivateEndpoint("HsmPe", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: hsm.managedHsmId,
          groupIds: ["managedhsm"],
          requestMessage: "please approve",
        },
      ],
    });
    const connection = approval
      ? yield* Azure.KeyVault.ManagedHsmPrivateEndpointConnection(
          "HsmPeApproval",
          {
            resourceGroup: group.resourceGroupName,
            managedHsm: hsm.managedHsmName,
            privateEndpointId: endpoint.privateEndpointId,
            status: approval.status,
            description: approval.description,
          },
        )
      : undefined;
    return { group, hsm, endpoint, connection };
  });

// The managed HSM is billed ~$3.20/hour until purged and takes 20-30
// minutes to provision; the private endpoint adds ~$0.01/hour. Roughly
// $2-3 and 45 minutes per run.
test.provider.skipIf(!runExpensive)(
  "approve, reject, and delete a managed HSM private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ status: "Approved", description: "approved by alchemy" }),
      );
      const rg = created.group.resourceGroupName;
      const hsmName = created.hsm.managedHsmName;
      const name = created.connection!.privateEndpointConnectionName;
      expect(created.connection!.status).toEqual("Approved");
      const observed = yield* getConnection(rg, hsmName, name);
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
      const reobserved = yield* getConnection(rg, hsmName, name);
      expect(
        reobserved.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Rejected");

      // Removing the resource deletes the connection.
      yield* stack.deploy(program());
      expect(yield* connectionGone(rg, hsmName, name)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 7_200_000,
  },
);
