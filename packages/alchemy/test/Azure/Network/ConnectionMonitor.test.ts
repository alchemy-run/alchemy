import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import { runExpensive, withVcpus } from "../gates.ts";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

// A VM source: Standard_D2as_v4 (~$0.10/hour) plus disk, ~10-15 minutes
// with the Network Watcher agent install. Runs only with
// AZURE_TEST_EXPENSIVE=1. A subscription holds one watcher per region and
// Azure auto-creates it (NetworkWatcher_<region> in NetworkWatcherRG) with
// the first VNet, so the test uses eastus's existing watcher: other regions
// refuse this subscription small VM sizes (SkuNotAvailable).
const REGION = "eastus";
const WATCHER_GROUP = "NetworkWatcherRG";
const WATCHER = "NetworkWatcher_eastus";
const PUBLIC_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";

const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: REGION,
  });
  const watcher = { networkWatcherName: WATCHER };
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    location: REGION,
    addressPrefixes: ["10.0.0.0/16"],
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
    vmSize: "Standard_D2as_v4",
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

const getMonitor = (
  resourceGroupName: string,
  networkWatcherName: string,
  connectionMonitorName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetConnectionMonitor({
      subscriptionId,
      resourceGroupName,
      networkWatcherName,
      connectionMonitorName,
    }),
  );

const program = (props: { frequency: number; env: string }) =>
  Effect.gen(function* () {
    const { group, watcher, vm, agent } = yield* base;
    const monitor = yield* Azure.Network.ConnectionMonitor("Web", {
      resourceGroup: WATCHER_GROUP,
      networkWatcher: watcher.networkWatcherName,
      location: REGION,
      endpoints: [
        { name: "vm", type: "AzureVM", resourceId: vm.virtualMachineId },
        { name: "bing", type: "ExternalAddress", address: "www.bing.com" },
      ],
      testConfigurations: [
        {
          name: "https",
          protocol: "Http",
          testFrequencySec: props.frequency,
          httpConfiguration: { port: 443, preferHTTPS: true },
        },
      ],
      testGroups: [
        {
          name: "web",
          sources: ["vm"],
          destinations: ["bing"],
          testConfigurations: ["https"],
        },
      ],
      notes: agent.extensionName,
      tags: { env: props.env },
    });
    return { group, watcher, monitor };
  });

test.provider.skipIf(!runExpensive)(
  "create, update, and delete a connection monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { watcher, monitor } = yield* stack.deploy(
        program({ frequency: 60, env: "test" }),
      );
      expect(monitor.testGroupNames).toEqual(["web"]);

      const updated = yield* stack.deploy(
        program({ frequency: 120, env: "prod" }),
      );
      expect(updated.monitor.connectionMonitorId).toEqual(
        monitor.connectionMonitorId,
      );
      const observed = yield* getMonitor(
        WATCHER_GROUP,
        watcher.networkWatcherName,
        monitor.connectionMonitorName,
      );
      expect(
        observed.properties?.testConfigurations?.[0]?.testFrequencySec,
      ).toEqual(120);
      expect(observed.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getMonitor(
            WATCHER_GROUP,
            watcher.networkWatcherName,
            monitor.connectionMonitorName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 1_800_000 },
);
