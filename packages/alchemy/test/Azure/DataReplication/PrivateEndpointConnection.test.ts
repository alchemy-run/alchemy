import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  LOCATION,
  logLevel,
  subscription,
  tags,
  vaultStack,
  waitGone,
} from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (description: string) =>
  Effect.gen(function* () {
    const { group, vault } = yield* vaultStack;
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Endpoints", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const endpoint = yield* Azure.Network.PrivateEndpoint("VaultEndpoint", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      subnetId: subnet.subnetId,
      manualPrivateLinkServiceConnections: [
        { privateLinkServiceId: vault.vaultId, groupIds: ["DataReplication"] },
      ],
    });
    const approval = yield* Azure.DataReplication.PrivateEndpointConnection(
      "Approval",
      {
        resourceGroup: group.resourceGroupName,
        vault: vault.vaultName,
        privateEndpointId: endpoint.privateEndpointId,
        description,
      },
    );
    return { group, vault, endpoint, approval };
  });

const getConnection = (rg: string, vault: string, name: string) =>
  Effect.gen(function* () {
    return yield* dr.GetPrivateEndpointConnection({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      vaultName: vault,
      privateEndpointConnectionName: name,
    });
  });

// Vault is free; private endpoint ~$0.01/h; VNet free. ~5 minutes.
// Private endpoints to a data replication vault are refused unless the
// subscription has the `Microsoft.Network/AllowPrivateEndpoints` feature
// registered, which the test subscription does not. Run with
// AZURE_TEST_PAID=1 on a subscription with the feature registered.
test.provider.skipIf(!runPaidOnly)(
  "approve, update, and delete a data replication private endpoint connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vault, endpoint, approval } = yield* stack.deploy(
        program("approved by alchemy"),
      );
      const rg = group.resourceGroupName;
      expect(approval.status).toEqual("Approved");
      expect(approval.privateEndpointId?.toLowerCase()).toEqual(
        endpoint.privateEndpointId.toLowerCase(),
      );
      const observed = yield* getConnection(
        rg,
        vault.vaultName,
        approval.privateEndpointConnectionName,
      );
      expect(
        observed.properties?.privateLinkServiceConnectionState?.status,
      ).toEqual("Approved");
      expect(
        observed.properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("approved by alchemy");

      // In place: description.
      const updated = yield* stack.deploy(program("re-approved"));
      expect(updated.approval.privateEndpointConnectionName).toEqual(
        approval.privateEndpointConnectionName,
      );
      expect(
        (yield* getConnection(
          rg,
          vault.vaultName,
          approval.privateEndpointConnectionName,
        )).properties?.privateLinkServiceConnectionState?.description,
      ).toEqual("re-approved");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getConnection(
            rg,
            vault.vaultName,
            approval.privateEndpointConnectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~2 minutes): without the feature registration the
// private endpoint to the vault is rejected with a typed error.
test.provider(
  "probe: a private endpoint to a vault needs the AllowPrivateEndpoints feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(program("approved by alchemy"))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SubscriptionFeatureNotRegistered");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
