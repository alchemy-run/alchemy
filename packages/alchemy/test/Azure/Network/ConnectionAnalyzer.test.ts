import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import { runExpensive, withVcpus } from "../gates.ts";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

// A VM source: Standard_F1als_v7 (~$0.04/hour) plus disk, ~10-15 minutes
// with the Network Watcher agent install. Runs only with
// AZURE_TEST_EXPENSIVE=1. The test owns the region's watcher, so it runs in
// a region without VNets and orders the VNet after the watcher.
const REGION = "canadacentral";
const PUBLIC_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";

const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: REGION,
  });
  const watcher = yield* Azure.Network.NetworkWatcher("Watcher", {
    resourceGroup: group.resourceGroupName,
    location: REGION,
  });
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    location: REGION,
    addressPrefixes: ["10.0.0.0/16"],
    tags: { watcher: watcher.networkWatcherName },
  });
  const subnet = yield* Azure.Network.Subnet("Default", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.1.0/24",
  });
  const nic = yield* Azure.Network.NetworkInterface("Nic", {
    resourceGroup: group.resourceGroupName,
    location: REGION,
    ipConfigurations: [{ subnetId: subnet.subnetId }],
  });
  const vm = yield* Azure.Compute.VirtualMachine("Vm", {
    resourceGroup: group.resourceGroupName,
    location: REGION,
    vmSize: "Standard_F1als_v7",
    networkInterfaceIds: [nic.networkInterfaceId],
    adminUsername: "azureuser",
    sshPublicKeys: [PUBLIC_KEY],
  });
  const agent = yield* Azure.Compute.VirtualMachineExtension("Agent", {
    resourceGroup: group.resourceGroupName,
    virtualMachine: vm.virtualMachineName,
    publisher: "Microsoft.Azure.NetworkWatcher",
    type: "NetworkWatcherAgentLinux",
    typeHandlerVersion: "1.4",
  });
  return { group, watcher, vm, agent };
});

const getAnalyzer = (
  resourceGroupName: string,
  networkWatcherName: string,
  connectionAnalyzerName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkWatchersConnectionAnalyzer({
      subscriptionId,
      resourceGroupName,
      networkWatcherName,
      connectionAnalyzerName,
    }),
  );

const program = (props: {
  operations: ("ConnectivityCheck" | "NextHop")[];
  env: string;
}) =>
  Effect.gen(function* () {
    const { group, watcher, vm } = yield* base;
    const analyzer = yield* Azure.Network.ConnectionAnalyzer("VmToWeb", {
      resourceGroup: group.resourceGroupName,
      networkWatcher: watcher.networkWatcherName,
      location: REGION,
      source: { type: "VM", resourceId: vm.virtualMachineId },
      destination: {
        type: "ExternalAddress",
        address: "www.bing.com",
        port: 443,
      },
      diagnosticOperations: props.operations,
      tags: { env: props.env },
    });
    return { group, watcher, analyzer };
  });

test.provider.skipIf(!runExpensive)(
  "create, update, and delete a connection analyzer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, watcher, analyzer } = yield* stack.deploy(
        program({ operations: ["ConnectivityCheck"], env: "test" }),
      );
      expect(analyzer.source?.type).toEqual("VM");

      const updated = yield* stack.deploy(
        program({ operations: ["ConnectivityCheck", "NextHop"], env: "prod" }),
      );
      expect(updated.analyzer.connectionAnalyzerId).toEqual(
        analyzer.connectionAnalyzerId,
      );
      const observed = yield* getAnalyzer(
        group.resourceGroupName,
        watcher.networkWatcherName,
        analyzer.connectionAnalyzerName,
      );
      expect(observed.properties?.diagnosticOperations).toEqual([
        "ConnectivityCheck",
        "NextHop",
      ]);
      expect(observed.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getAnalyzer(
            group.resourceGroupName,
            watcher.networkWatcherName,
            analyzer.connectionAnalyzerName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
