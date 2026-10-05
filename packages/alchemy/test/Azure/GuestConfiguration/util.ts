import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:guestconfiguration",
  "live",
];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Fixture identity for pre-registering an Arc machine without an agent: a
 * fixed host ID and a PKCS#1 RSA public key (no private key kept).
 */
export const fixtureVmId = "5a1e7c3d-9b2f-4d6a-8e4c-1f0b3a7d9e25";
export const fixturePublicKey =
  "MIIBCgKCAQEAqB72SMX+EJZIkpTSteGm7YVERSZMz/iBOpd0xkv3OBzHlJA1E4WbK5+gxu7Xr0boJ9nLvWacOWsxSeBaHggJnjnRGSV/AWt+VY6M8K1FGCqms7W8t3MrjuMuTr3UgLiqRXOY2QpnqPlIX6YDq5/+nsqi7btGHXvsmJ+0qKAv84NyFlS3f6lpgmNUgpAV+NMR95BBdYTGFqwVpIj1fnjXY/LVKYPCnN/6JMGUvSn4BdCbWUCam8Wi2kHVNl0jkdoGFL+Lq72uPydoHs+7N6bheshpPwdX0drvykvdEx3UaZYOApy8l20tZ69yJqPTSqfms+KUStMj30ZhgI2CBVke3wIDAQAB";

/** Checked-in OpenSSH public key (private half discarded). */
export const PUBLIC_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";

/**
 * Region and size for VM-backed tests: the 1-vCPU F-series v7 sizes are
 * unrestricted on the trial subscription (B-series is `SkuNotAvailable`).
 */
export const VM_LOCATION = process.env.AZURE_TEST_VM_LOCATION ?? "eastus";
export const VM_SIZE = process.env.AZURE_TEST_VM_SIZE ?? "Standard_F1als_v7";

/**
 * Resource group, VNet, subnet, and a NIC without a public IP. All free.
 * Guest configuration fails to resolve hosts whose ARM ID is too long
 * (`GuestConfigurationMachineInfoUnavailable`), so tests pass a short
 * group name instead of the long engine default.
 */
export const vmNetwork = (groupName?: string, location = VM_LOCATION) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: groupName,
      location,
    });
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

/**
 * Retry while the service intermittently fails to look up the host
 * machine.
 */
export const whileLookupFails = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "GuestConfigurationMachineLookupFailed" ||
    e._tag === "GuestConfigurationMachineInfoUnavailable",
  schedule: Schedule.spaced("10 seconds"),
  times: 36,
};

/** Poll an out-of-band observation until it reports `undefined`. */
export const waitAbsent = <A, E, R>(
  observe: Effect.Effect<A | undefined, E, R>,
) =>
  observe.pipe(
    Effect.map((value) => (value === undefined ? "gone" : "found")),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );
