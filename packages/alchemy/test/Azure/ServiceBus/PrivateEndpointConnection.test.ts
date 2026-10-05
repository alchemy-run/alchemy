import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getConnection = (
  resourceGroupName: string,
  namespaceName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      privateEndpointConnectionName,
    });
  });

const connectionGone = (
  resourceGroupName: string,
  namespaceName: string,
  privateEndpointConnectionName: string,
) =>
  getConnection(
    resourceGroupName,
    namespaceName,
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
  description: string,
  status: Azure.ServiceBus.PrivateEndpointConnectionStatus = "Approved",
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bus = yield* Azure.ServiceBus.Namespace("Bus", {
      resourceGroup: group.resourceGroupName,
      sku: "Premium",
      capacity: 1,
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
    const endpoint = yield* Azure.Network.PrivateEndpoint("BusEndpoint", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        { privateLinkServiceId: bus.namespaceId, groupIds: ["namespace"] },
      ],
    });
    const approval = yield* Azure.ServiceBus.PrivateEndpointConnection(
      "Approval",
      {
        resourceGroup: group.resourceGroupName,
        namespace: bus.namespaceName,
        privateEndpointId: endpoint.privateEndpointId,
        status,
        description,
      },
    );
    return { group, bus, endpoint, approval };
  });

// Premium namespace (1 MU, ~$0.93/h, billed per started hour) + private
// endpoint (~$0.01/h) => ~$0.95 per run; Premium provisioning ~5-20 min.
// Gated behind AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "approve, update, and delete a service bus private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, endpoint, approval } = yield* stack.deploy(
        program("approved by alchemy"),
      );
      const rg = group.resourceGroupName;
      expect(approval.status).toEqual("Approved");
      expect(approval.privateEndpointId?.toLowerCase()).toEqual(
        endpoint.privateEndpointId.toLowerCase(),
      );
      const observed = yield* getConnection(
        rg,
        bus.namespaceName,
        approval.privateEndpointConnectionName,
      );
      expect(
        observed.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("approved by alchemy");

      // Description-only change: Service Bus rejects same-state transitions,
      // so the deploy succeeds and the recorded description is kept.
      const unchanged = yield* stack.deploy(program("re-approved"));
      expect(unchanged.approval.status).toEqual("Approved");
      expect(unchanged.approval.description).toEqual("approved by alchemy");

      // In place: status transition carries the new description.
      const updated = yield* stack.deploy(
        program("rejected by alchemy", "Rejected"),
      );
      expect(updated.approval.privateEndpointConnectionName).toEqual(
        approval.privateEndpointConnectionName,
      );
      const reobserved = yield* getConnection(
        rg,
        bus.namespaceName,
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
          bus.namespaceName,
          approval.privateEndpointConnectionName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 1_800_000,
  },
);
