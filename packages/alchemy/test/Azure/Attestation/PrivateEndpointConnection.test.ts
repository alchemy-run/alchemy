import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as attestation from "@distilled.cloud/azure/attestation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getConnection = (
  resourceGroupName: string,
  providerName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* attestation.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      providerName,
      privateEndpointConnectionName,
    });
  });

const connectionGone = (
  resourceGroupName: string,
  providerName: string,
  privateEndpointConnectionName: string,
) =>
  getConnection(
    resourceGroupName,
    providerName,
    privateEndpointConnectionName,
  ).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

const program = (
  status: Azure.Attestation.PrivateEndpointConnectionStatus,
  description: string,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const provider = yield* Azure.Attestation.Provider("Attest", {
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
    const endpoint = yield* Azure.Network.PrivateEndpoint("AttestEndpoint", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        { privateLinkServiceId: provider.providerId, groupIds: ["standard"] },
      ],
    });
    const approval = yield* Azure.Attestation.PrivateEndpointConnection(
      "Approval",
      {
        resourceGroup: group.resourceGroupName,
        provider: provider.providerName,
        privateEndpointId: endpoint.privateEndpointId,
        status,
        description,
      },
    );
    return { group, provider, endpoint, approval };
  });

// Attestation provider is free; private endpoint ~$0.01/h; a run takes a
// few minutes => well under $0.05.
test.provider(
  "approve, update, and delete an attestation private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, provider, endpoint, approval } = yield* stack.deploy(
        program("Approved", "approved by alchemy"),
      );
      const rg = group.resourceGroupName;
      expect(approval.status).toEqual("Approved");
      expect(approval.privateEndpointId?.toLowerCase()).toEqual(
        endpoint.privateEndpointId.toLowerCase(),
      );
      const observed = yield* getConnection(
        rg,
        provider.providerName,
        approval.privateEndpointConnectionName,
      );
      expect(
        observed.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("approved by alchemy");

      // In place: status (the service only accepts status transitions).
      const updated = yield* stack.deploy(
        program("Rejected", "rejected by alchemy"),
      );
      expect(updated.approval.status).toEqual("Rejected");
      expect(updated.approval.privateEndpointConnectionName).toEqual(
        approval.privateEndpointConnectionName,
      );
      const reobserved = yield* getConnection(
        rg,
        provider.providerName,
        approval.privateEndpointConnectionName,
      );
      expect(
        reobserved.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Rejected");
      expect(
        reobserved.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("rejected by alchemy");

      yield* stack.destroy();
      expect(
        yield* connectionGone(
          rg,
          provider.providerName,
          approval.privateEndpointConnectionName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:attestation", "live"],
    timeout: 900_000,
  },
);
