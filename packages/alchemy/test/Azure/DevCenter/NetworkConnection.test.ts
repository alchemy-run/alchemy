import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNetworkConnection = (
  resourceGroupName: string,
  networkConnectionName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetNetworkConnection({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkConnectionName,
    });
  });

const network = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    location: "eastus",
    addressPrefixes: ["10.42.0.0/16"],
  });
  const one = yield* Azure.Network.Subnet("One", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.42.1.0/24",
  });
  const two = yield* Azure.Network.Subnet("Two", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.42.2.0/24",
  });
  return { group, one, two };
});

const program = (props: {
  subnet: "one" | "two";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, one, two } = yield* network;
    // Both subnets stay deployed across the replacement step below.
    const connection = yield* Azure.DevCenter.NetworkConnection("Connection", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      subnetId: props.subnet === "one" ? one.subnetId : two.subnetId,
      tags: props.tags,
    });
    return { group, one, two, connection };
  });

// Ungated, ~1 minute, $0: the trial subscription has no Dev Box network
// connection quota (eastus), so creation is rejected with a typed
// 409 `ResourceQuotaExceeded`.
test.provider(
  "network connection creation is rejected without Dev Box quota",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, one } = yield* stack.deploy(network);
      const error = yield* devcenter
        .NetworkConnectionsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          networkConnectionName: "alchemy-probe",
          location: "eastus",
          properties: { subnetId: one.subnetId, domainJoinType: "AzureADJoin" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("DevCenterNetworkConnectionQuotaExceeded");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Gated: needs Dev Box network connection quota (see the probe above).
// Network connections are free; Azure runs health checks and creates a
// networking resource group, ~5-10 minutes in total, $0.
// Skipped: failed in the last live run. DevCenterNetworkConnectionQuotaExceeded: networkConnections
// cannot be created in the eastus region at this time, because the resource quota has been exceeded
// in that region. Please request a quota limit increase. https:/
test.provider.skip(
  "create, update, replace, and delete a network connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, one, connection } = yield* stack.deploy(
        program({ subnet: "one", tags: { a: "1" } }),
      );
      expect(connection.domainJoinType).toEqual("AzureADJoin");
      const observed = yield* getNetworkConnection(
        group.resourceGroupName,
        connection.networkConnectionName,
      );
      expect(observed.properties?.subnetId?.toLowerCase()).toEqual(
        one.subnetId.toLowerCase(),
      );
      expect(observed.tags?.a).toEqual("1");
      expect(observed.tags?.["alchemy::id"]).toEqual("Connection");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ subnet: "one", tags: { a: "2" } }),
      );
      expect(updated.connection.networkConnectionId).toEqual(
        connection.networkConnectionId,
      );
      const reobserved = yield* getNetworkConnection(
        group.resourceGroupName,
        connection.networkConnectionName,
      );
      expect(reobserved.tags?.a).toEqual("2");

      // Replacement: the subnet is immutable.
      const replaced = yield* stack.deploy(
        program({ subnet: "two", tags: { a: "2" } }),
      );
      expect(replaced.connection.networkConnectionName).not.toEqual(
        connection.networkConnectionName,
      );
      expect(replaced.connection.subnetId.toLowerCase()).toEqual(
        replaced.two.subnetId.toLowerCase(),
      );
      expect(
        yield* waitGone(
          getNetworkConnection(
            group.resourceGroupName,
            connection.networkConnectionName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getNetworkConnection(
            group.resourceGroupName,
            replaced.connection.networkConnectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
