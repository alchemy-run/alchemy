import * as Azure from "@alchemy.run/azure";
import * as relay from "@distilled.cloud/azure/relay";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { gone, logLevel, namespaceProgram, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  namespaceName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    relay.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      privateEndpointConnectionName,
    }),
  );

const program = (
  description: string,
  status: Azure.Relay.PrivateEndpointConnectionStatus = "Approved",
) =>
  Effect.gen(function* () {
    const { group, ns } = yield* namespaceProgram;
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("RelayEndpoint", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        { privateLinkServiceId: ns.namespaceId, groupIds: ["namespace"] },
      ],
    });
    const approval = yield* Azure.Relay.PrivateEndpointConnection("Approval", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      privateEndpointId: endpoint.privateEndpointId,
      status,
      description,
    });
    return { group, ns, endpoint, approval };
  });

// Relay Standard namespace (idle, ~$0) + private endpoint (~$0.01/h) =>
// < $0.01 per run; ~5 min.
test.provider(
  "approve, update, and delete a relay private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, endpoint, approval } = yield* stack.deploy(program("approved by alchemy"));
      const rg = group.resourceGroupName;
      expect(approval.status).toEqual("Approved");
      expect(approval.privateEndpointId?.toLowerCase()).toEqual(
        endpoint.privateEndpointId.toLowerCase(),
      );
      const observed = yield* getConnection(
        rg,
        ns.namespaceName,
        approval.privateEndpointConnectionName,
      );
      expect(observed.properties?.privateLinkServiceConnectionState?.status).toEqual("Approved");
      expect(observed.properties?.privateLinkServiceConnectionState?.description).toEqual(
        "approved by alchemy",
      );

      // In place: reject the connection with a new description.
      const updated = yield* stack.deploy(program("rejected by alchemy", "Rejected"));
      expect(updated.approval.privateEndpointConnectionName).toEqual(
        approval.privateEndpointConnectionName,
      );
      expect(updated.approval.status).toEqual("Rejected");
      const reobserved = yield* getConnection(
        rg,
        ns.namespaceName,
        approval.privateEndpointConnectionName,
      );
      expect(reobserved.properties?.privateLinkServiceConnectionState?.status).toEqual("Rejected");
      expect(reobserved.properties?.privateLinkServiceConnectionState?.description).toEqual(
        "rejected by alchemy",
      );

      // Removing only the approval deletes the connection; the namespace stays.
      yield* stack.deploy(namespaceProgram);
      expect(
        yield* gone(getConnection(rg, ns.namespaceName, approval.privateEndpointConnectionName)),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
