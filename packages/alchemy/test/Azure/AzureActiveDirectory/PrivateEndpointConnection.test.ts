import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { Retry } from "@distilled.cloud/azure";
import * as aad from "@distilled.cloud/azure/azureactivedirectory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  policyName: string,
  privateEndpointConnectionName: string,
) =>
  Effect.gen(function* () {
    return yield* aad.GetPrivateEndpointConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      policyName,
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
    const policy = yield* Azure.AzureActiveDirectory.PrivateLinkPolicy(
      "Policy",
      { resourceGroup: group.resourceGroupName },
    );
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("Entra", {
      resourceGroup: group.resourceGroupName,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        {
          privateLinkServiceId: policy.policyId,
          groupIds: ["azuread"],
          requestMessage: "alchemy test",
        },
      ],
    });
    const connection =
      yield* Azure.AzureActiveDirectory.PrivateEndpointConnection("Approval", {
        resourceGroup: group.resourceGroupName,
        policy: policy.policyName,
        privateEndpointId: endpoint.privateEndpointId,
        status: props.status,
        description: props.description,
      });
    return { group, policy, endpoint, connection };
  });

// Needs the `privateLinkForAzureAd` resource type (preview; absent from the
// trial subscription's `microsoft.aadiam` manifest — see the probe in
// PrivateLinkPolicy.test.ts) and a Global Administrator caller. Private
// endpoint ~$0.01/hour; a few minutes.
test.provider.skipIf(!runPaidOnly)(
  "approve, update, and delete an Entra private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy, connection } = yield* stack.deploy(
        program({ status: "Approved", description: "approved by alchemy" }),
      );
      expect(connection.status).toEqual("Approved");
      const get = () =>
        getConnection(
          group.resourceGroupName,
          policy.policyName,
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

// Ungated probe ($0, no resources): connections live under a policy, whose
// resource type the trial subscription does not expose.
test.provider.skipIf(runPaidOnly)(
  "the trial subscription rejects Entra private endpoint connections",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* aad
        .ListPrivateEndpointConnectionByPolicyName({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          policyName: "alchemy-probe",
        })
        .pipe(Retry.none, Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
