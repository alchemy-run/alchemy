import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datafactory from "@distilled.cloud/azure/datafactory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getManagedVirtualNetwork = (
  resourceGroupName: string,
  factoryName: string,
  managedVirtualNetworkName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetManagedVirtualNetwork({
      subscriptionId,
      resourceGroupName,
      factoryName,
      managedVirtualNetworkName,
    });
  });

const managedVirtualNetworkGone = (
  resourceGroupName: string,
  factoryName: string,
  managedVirtualNetworkName: string,
) =>
  getManagedVirtualNetwork(
    resourceGroupName,
    factoryName,
    managedVirtualNetworkName,
  ).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("ManagedVnetGroup", {
    location: "eastus",
  });
  const factory = yield* Azure.DataFactory.Factory("ManagedVnetFactory", {
    resourceGroup: group.resourceGroupName,
  });
  const vnet = yield* Azure.DataFactory.ManagedVirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    factoryName: factory.factoryName,
  });
  return { group, factory, vnet };
});

// ~$0: a managed virtual network without a running IR is free. ~1 minute.
test.provider(
  "create and delete a managed virtual network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, vnet } = yield* stack.deploy(program);
      expect(vnet.managedVirtualNetworkName).toEqual("default");
      expect(vnet.vNetId).toBeTruthy();
      const observed = yield* getManagedVirtualNetwork(
        group.resourceGroupName,
        factory.factoryName,
        "default",
      );
      expect(observed.properties.vNetId).toEqual(vnet.vNetId);
      expect(observed.id?.toLowerCase()).toEqual(
        vnet.managedVirtualNetworkId.toLowerCase(),
      );

      // Re-deploy is a no-op that keeps the same network.
      const again = yield* stack.deploy(program);
      expect(again.vnet.vNetId).toEqual(vnet.vNetId);

      // No delete API: the network is reclaimed with the factory.
      yield* stack.destroy();
      expect(
        yield* managedVirtualNetworkGone(
          group.resourceGroupName,
          factory.factoryName,
          "default",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
