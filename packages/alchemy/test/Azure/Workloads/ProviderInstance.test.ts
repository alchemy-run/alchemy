import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as workloads from "@distilled.cloud/azure/workloads";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withVcpus } from "../gates.ts";
import {
  AMS_LOCATION,
  logLevel,
  monitorStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const PUBLIC_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";

// cloud-init (base64): `#cloud-config` installing prometheus-node-exporter,
// which serves on :9100.
const NODE_EXPORTER =
  "I2Nsb3VkLWNvbmZpZwpwYWNrYWdlczoKICAtIHByb21ldGhldXMtbm9kZS1leHBvcnRlcgo=";

const getInstance = (
  resourceGroupName: string,
  monitorName: string,
  providerInstanceName: string,
) =>
  Effect.gen(function* () {
    return yield* workloads.GetProviderInstance({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
      providerInstanceName,
    });
  });

const program = (sapSid: string) =>
  Effect.gen(function* () {
    const { group, vnet, monitor } = yield* monitorStack({});
    const hosts = yield* Azure.Network.Subnet("Hosts", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.20.2.0/24",
    });
    const nic = yield* Azure.Network.NetworkInterface("Nic", {
      resourceGroup: group.resourceGroupName,
      location: AMS_LOCATION,
      ipConfigurations: [{ subnetId: hosts.subnetId }],
    });
    const vm = yield* Azure.Compute.VirtualMachine("Host", {
      resourceGroup: group.resourceGroupName,
      location: AMS_LOCATION,
      // B1s is capacity-restricted (SkuNotAvailable) in eastus.
      vmSize: "Standard_F1als_v7",
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY],
      customData: NODE_EXPORTER,
    });
    const instance = yield* Azure.Workloads.ProviderInstance("Os", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      providerSettings: {
        providerType: "PrometheusOS",
        prometheusUrl: Output.interpolate`http://${nic.privateIpAddress}:9100/metrics`,
        sapSid,
      },
    });
    return { group, monitor, vm, instance };
  });

// Needs an AMS monitor (~$0.25/hour, 10-20 minutes to create, ~10-30 to
// delete) plus an F1als_v7 VM running node_exporter (~$0.03/hour). Runs only with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a PrometheusOS provider instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, monitor, instance } = yield* stack.deploy(program("S4H"));
      expect(instance.providerType).toEqual("PrometheusOS");
      expect(instance.provisioningState).toEqual("Succeeded");
      const observed = yield* getInstance(
        group.resourceGroupName,
        monitor.monitorName,
        instance.providerInstanceName,
      );
      expect(observed.properties?.providerSettings?.sapSid).toEqual("S4H");
      expect(observed.properties?.providerSettings?.prometheusUrl).toMatch(
        /^http:\/\/10\.20\.2\.\d+:9100\/metrics$/,
      );

      // Any settings change re-creates the instance.
      const replaced = yield* stack.deploy(program("S4Q"));
      expect(replaced.instance.providerInstanceName).not.toEqual(
        instance.providerInstanceName,
      );
      const replacedObserved = yield* getInstance(
        group.resourceGroupName,
        monitor.monitorName,
        replaced.instance.providerInstanceName,
      );
      expect(replacedObserved.properties?.providerSettings?.sapSid).toEqual(
        "S4Q",
      );
      expect(
        yield* waitGone(
          getInstance(
            group.resourceGroupName,
            monitor.monitorName,
            instance.providerInstanceName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getInstance(
            group.resourceGroupName,
            monitor.monitorName,
            replaced.instance.providerInstanceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 7_200_000 },
);

// Ungated probe (free: one empty resource group): reading a provider
// instance of a monitor that does not exist fails with the typed `NotFound`
// the provider treats as "absent" on read and delete.
test.provider(
  "a provider instance of a missing monitor reads as a typed not-found",
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
      const error = yield* getInstance(
        group.resourceGroupName,
        "missing",
        "missing",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      const deleteError = yield* Effect.gen(function* () {
        return yield* workloads.DeleteProviderInstance({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          monitorName: "missing",
          providerInstanceName: "missing",
        });
      }).pipe(Effect.flip);
      expect(deleteError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
