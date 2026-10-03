import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const LOCATION = "eastus";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  sandboxGroupName: string,
  vnetConnectionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetVnetConnection({
      subscriptionId,
      resourceGroupName,
      sandboxGroupName,
      vnetConnectionName,
    });
  });

const program = (subnet: "A" | "B") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.40.0.0/16"],
    });
    // Both subnets stay deployed across the replacement step. Sandbox
    // groups require the Microsoft.App/environments delegation.
    const subnetA = yield* Azure.Network.Subnet("SubnetA", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.40.1.0/24",
      delegations: [{ serviceName: "Microsoft.App/environments" }],
    });
    const subnetB = yield* Azure.Network.Subnet("SubnetB", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.40.2.0/24",
      delegations: [{ serviceName: "Microsoft.App/environments" }],
    });
    const sandboxes = yield* Azure.ContainerApps.SandboxGroup("Sandboxes", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const connection = yield* Azure.ContainerApps.SandboxVnetConnection(
      "Connection",
      {
        resourceGroup: group.resourceGroupName,
        sandboxGroup: sandboxes.sandboxGroupName,
        subnetId: subnet === "A" ? subnetA.subnetId : subnetB.subnetId,
      },
    );
    return { group, sandboxes, subnetA, subnetB, connection };
  });

// Cost: VNet, subnets, and an empty sandbox group are free (~$0).
test.provider(
  "create, replace, and delete a sandbox vnet connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, sandboxes, subnetA, connection } = yield* stack.deploy(
        program("A"),
      );
      expect(connection.subnetId.toLowerCase()).toEqual(
        subnetA.subnetId.toLowerCase(),
      );
      const get = getConnection(
        group.resourceGroupName,
        sandboxes.sandboxGroupName,
        connection.connectionName,
      );
      expect((yield* get).properties?.provisioningState).toEqual("Succeeded");

      // Replacement: a new subnet recreates the connection.
      const replaced = yield* stack.deploy(program("B"));
      expect(replaced.connection.subnetId.toLowerCase()).toEqual(
        replaced.subnetB.subnetId.toLowerCase(),
      );
      // Replacement creates a new connection and deletes the old one.
      expect(replaced.connection.connectionName).not.toEqual(
        connection.connectionName,
      );
      const getReplaced = getConnection(
        group.resourceGroupName,
        sandboxes.sandboxGroupName,
        replaced.connection.connectionName,
      );
      expect((yield* getReplaced).properties?.subnetId?.toLowerCase()).toEqual(
        replaced.subnetB.subnetId.toLowerCase(),
      );
      expect(yield* waitGone(get)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getReplaced)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 900_000,
  },
);
