import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:compute", "live"];

/** The subscription the tests run against. */
export const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const untilGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/** Checked-in OpenSSH public keys (private halves discarded). */
export const PUBLIC_KEY_1 =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";
export const PUBLIC_KEY_2 =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCuHXO3OSXE38GaXjCIQ0G2Plmp0a4Lc1B/U+6sSjHklGQ+oK3ifMXH6HhOlqcyW4HmAFLvZ+MpVsrYZF+bSqN996PRF7TQzp3c0NT49jmTLB1nzUWMa0OM6MnCzbbAIPGwYp+urMAHIlXoUZgghce0xzf7fxZ+cCm8Z3QRWGw59KjBY+f3FnfllzHGLmdgTeUes4YVI1kARU8OVSPqOPfj/eY6qrteuFsY/KjUZZoCcK6dRU3lj0hO/5gThjrOEV7Lb7Lb/UYVSke17sXSO4DcAAleIzz273QyF0U07Or1xm8UbRKUNvMkS6+5iLG4LAU9JuFjgYVrDEBcHxw1Z5nb alchemy-test-3";

/**
 * Region and sizes for VM-backed tests. The B-series (`Standard_B1s`) is
 * capacity-restricted (`SkuNotAvailable`) in eastus/westus2 on the trial
 * subscription; the 1-vCPU F-series v7 sizes are unrestricted.
 */
export const VM_LOCATION = process.env.AZURE_TEST_VM_LOCATION ?? "eastus";
export const VM_SIZE = process.env.AZURE_TEST_VM_SIZE ?? "Standard_F1als_v7";
/**
 * SCSI-controller size for restore point tests: restore points of VMs on
 * NVMe-only sizes (the v7 families) end in `Failed`.
 */
export const SCSI_VM_SIZE =
  process.env.AZURE_TEST_SCSI_VM_SIZE ?? "Standard_D2as_v4";
export const VM_SIZE_ALT =
  process.env.AZURE_TEST_VM_SIZE_ALT ?? "Standard_F1as_v7";

/**
 * Network for a VM: resource group, VNet, subnet, and a NIC without a
 * public IP. All free.
 */
export const vmNetwork = (location = VM_LOCATION) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Vms", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const nic = yield* Azure.Network.NetworkInterface("Nic", {
      resourceGroup: group.resourceGroupName,
      location,
      ipConfigurations: [{ subnetId: subnet.subnetId }],
    });
    return { group, vnet, subnet, nic };
  });
