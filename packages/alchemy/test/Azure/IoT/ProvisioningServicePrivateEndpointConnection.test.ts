import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dps from "@distilled.cloud/azure/deviceprovisioningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  resourceName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    return yield* dps.GetIotDpsResourcePrivateEndpointConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      privateEndpointConnectionName,
    });
  });

const program = (props: {
  status: "Approved" | "Rejected";
  description: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.IoT.ProvisioningService("Dps", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("DpsEndpoint", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: service.provisioningServiceId,
          groupIds: ["iotDps"],
        },
      ],
    });
    const approval =
      yield* Azure.IoT.ProvisioningServicePrivateEndpointConnection(
        "Approval",
        {
          resourceGroup: group.resourceGroupName,
          provisioningService: service.provisioningServiceName,
          privateEndpointId: endpoint.privateEndpointId,
          status: props.status,
          description: props.description,
        },
      );
    return { group, service, endpoint, approval };
  });

// DPS S1 (no fixed fee) + private endpoint (~$0.01/h) + VNet (free):
// < $0.05 per run. ~5 minutes.
test.provider(
  "approve, reject, and delete a DPS private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, endpoint, approval } = yield* stack.deploy(
        program({ status: "Approved", description: "approved by alchemy" }),
      );
      const rg = group.resourceGroupName;
      const get = () =>
        getConnection(
          rg,
          service.provisioningServiceName,
          approval.privateEndpointConnectionName,
        );
      expect(approval.status).toEqual("Approved");
      expect(approval.privateEndpointId?.toLowerCase()).toEqual(
        endpoint.privateEndpointId.toLowerCase(),
      );
      const observed = yield* get();
      expect(
        observed.properties.privateLinkServiceConnectionState.status,
      ).toEqual("Approved");
      expect(
        observed.properties.privateLinkServiceConnectionState.description,
      ).toEqual("approved by alchemy");

      // In place: reject with a new description.
      const updated = yield* stack.deploy(
        program({ status: "Rejected", description: "revoked by alchemy" }),
      );
      expect(updated.approval.privateEndpointConnectionName).toEqual(
        approval.privateEndpointConnectionName,
      );
      expect(updated.approval.status).toEqual("Rejected");
      const rejected = (yield* get()).properties
        .privateLinkServiceConnectionState;
      expect(rejected.status).toEqual("Rejected");
      expect(rejected.description).toEqual("revoked by alchemy");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
