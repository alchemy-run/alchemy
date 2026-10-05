import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  flexApp,
  flexConnectionString,
  flexStorage,
} from "./fixtures/flex-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getIntegration = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppSwiftVirtualNetworkConnection({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

/** "gone" once the app reports no subnet (or the app itself is gone). */
const integrationGone = (resourceGroupName: string, name: string) =>
  getIntegration(resourceGroupName, name).pipe(
    Effect.map((observed) =>
      observed.properties?.subnetResourceId
        ? ("found" as const)
        : ("gone" as const),
    ),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (connection: string, subnet: "A" | "B" | undefined) =>
  Effect.gen(function* () {
    const { group, app } = yield* flexApp(connection);
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      addressPrefixes: ["10.40.0.0/16"],
    });
    // Flex Consumption integrates with subnets delegated to
    // Microsoft.App/environments. Both subnets stay deployed so moving the
    // integration never removes a live dependency.
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
    if (subnet !== undefined) {
      yield* Azure.Web.VirtualNetworkIntegration("Integration", {
        resourceGroup: group.resourceGroupName,
        siteName: app.siteName,
        subnetId: subnet === "A" ? subnetA.subnetId : subnetB.subnetId,
      });
    }
    return { group, app, subnetA, subnetB };
  });

// Cost: ~$0 (Flex Consumption, idle; VNets are free; Standard_LRS
// storage). Dedicated plans need Basic+, which has no trial quota.
// Provisioning: ~3-5 minutes.
test.provider(
  "connect, move, and disconnect regional VNet integration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { app, subnetA, subnetB } = yield* stack.deploy(
        program(connection, "A"),
      );
      const observed = yield* getIntegration(
        group.resourceGroupName,
        app.siteName,
      );
      expect(observed.properties?.subnetResourceId?.toLowerCase()).toEqual(
        subnetA.subnetId.toLowerCase(),
      );

      // In-place update: move to the other subnet.
      yield* stack.deploy(program(connection, "B"));
      const moved = yield* getIntegration(
        group.resourceGroupName,
        app.siteName,
      );
      expect(moved.properties?.subnetResourceId?.toLowerCase()).toEqual(
        subnetB.subnetId.toLowerCase(),
      );

      // Delete: removing the resource disconnects the app.
      yield* stack.deploy(program(connection, undefined));
      expect(
        yield* integrationGone(group.resourceGroupName, app.siteName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
