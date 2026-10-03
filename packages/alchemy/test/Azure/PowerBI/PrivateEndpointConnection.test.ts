import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { Retry } from "@distilled.cloud/azure";
import * as powerbi from "@distilled.cloud/azure/powerbiprivatelinks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  azureResourceName: string,
  privateEndpointName: string,
) =>
  Effect.gen(function* () {
    return yield* powerbi.GetPrivateEndpointConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      azureResourceName,
      privateEndpointName,
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
    const service = yield* Azure.PowerBI.PrivateLinkService("Tenant", {
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
    const endpoint = yield* Azure.Network.PrivateEndpoint("PowerBI", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: service.privateLinkServiceId,
          groupIds: ["tenant"],
          requestMessage: "alchemy test",
        },
      ],
    });
    const connection = yield* Azure.PowerBI.PrivateEndpointConnection(
      "Approval",
      {
        resourceGroup: group.resourceGroupName,
        privateLinkService: service.privateLinkServiceName,
        privateEndpointId: endpoint.privateEndpointId,
        status: props.status,
        description: props.description,
      },
    );
    return { group, service, endpoint, connection };
  });

// Needs a Power BI / Fabric tenant with Azure Private Link enabled by a
// tenant admin (Pro/Premium licensing); the trial tenant's resource provider
// answers every request with 502 Bad Gateway (see the probe in
// PrivateLinkService.test.ts). Private endpoint ~$0.01/hour; a few minutes.
test.provider.skipIf(!runPaidOnly)(
  "approve, update, and delete a Power BI private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, connection } = yield* stack.deploy(
        program({ status: "Approved", description: "approved by alchemy" }),
      );
      expect(connection.status).toEqual("Approved");
      const get = () =>
        getConnection(
          group.resourceGroupName,
          service.privateLinkServiceName,
          connection.privateEndpointConnectionName,
        );
      const observed = yield* get();
      expect(
        observed.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("approved by alchemy");

      // In-place: reject the connection.
      const updated = yield* stack.deploy(
        program({ status: "Rejected", description: "rejected by alchemy" }),
      );
      expect(updated.connection.privateEndpointConnectionId).toEqual(
        connection.privateEndpointConnectionId,
      );
      const reobserved = yield* get();
      expect(
        reobserved.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Rejected");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe ($0, no resources): the trial tenant's Power BI resource
// provider rejects every request with 502 Bad Gateway.
test.provider.skipIf(runPaidOnly)(
  "the Power BI resource provider rejects requests without Private Link",
  () =>
    Effect.gen(function* () {
      const error = yield* powerbi
        .ListPrivateLinkServicesForPowerBIBySubscriptionId({
          subscriptionId: yield* subscription,
        })
        .pipe(Retry.none, Effect.flip);
      expect(error._tag).toEqual("BadGateway");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
