import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:siterecovery", "live"];

/** Vault region; the primary fabric is in `PRIMARY`, recovery in `RECOVERY`. */
export const VAULT_LOCATION = "westus2";
export const PRIMARY = "eastus";
export const RECOVERY = "westus2";

export const subscription = Effect.map(Azure.AzureEnvironment.current, (env) => env.subscriptionId);

/** Resource group + Recovery Services vault (both free). */
export const vaultStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: VAULT_LOCATION,
  });
  const vault = yield* Azure.RecoveryServices.Vault("Vault", {
    resourceGroup: group.resourceGroupName,
    location: VAULT_LOCATION,
  });
  return { group, vault };
});

/** Vault plus A2A primary/recovery fabrics (~3 minutes). */
export const fabricsStack = Effect.gen(function* () {
  const { group, vault } = yield* vaultStack;
  const base = {
    resourceGroup: group.resourceGroupName,
    vault: vault.vaultName,
  };
  const primary = yield* Azure.SiteRecovery.Fabric("Primary", {
    ...base,
    location: PRIMARY,
  });
  const recovery = yield* Azure.SiteRecovery.Fabric("Recovery", {
    ...base,
    location: RECOVERY,
  });
  return { group, vault, base, primary, recovery };
});

/** Fabrics plus one A2A protection container in each (~4 minutes). */
export const containersStack = Effect.gen(function* () {
  const fabrics = yield* fabricsStack;
  const primaryContainer = yield* Azure.SiteRecovery.ProtectionContainer("PrimaryContainer", {
    ...fabrics.base,
    fabric: fabrics.primary.fabricName,
  });
  const recoveryContainer = yield* Azure.SiteRecovery.ProtectionContainer("RecoveryContainer", {
    ...fabrics.base,
    fabric: fabrics.recovery.fabricName,
  });
  return { ...fabrics, primaryContainer, recoveryContainer };
});

/** Containers plus an A2A replication policy (~4 minutes). */
export const policyStack = Effect.gen(function* () {
  const containers = yield* containersStack;
  const policy = yield* Azure.SiteRecovery.ReplicationPolicy("Policy", {
    ...containers.base,
    providerSpecificInput: {
      instanceType: "A2A",
      recoveryPointHistory: 1440,
      appConsistentFrequencyInMinutes: 240,
      multiVmSyncStatus: "Enable",
    },
  });
  return { ...containers, policy };
});

/** Checked-in OpenSSH public key (private half discarded). */
const PUBLIC_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";

/** A paired A2A container mapping plus a primary VM and its replication targets. */
export const replicationStack = Effect.gen(function* () {
  const base = yield* policyStack;
  const mapping = yield* Azure.SiteRecovery.ProtectionContainerMapping("Mapping", {
    ...base.base,
    fabric: base.primary.fabricName,
    protectionContainer: base.primaryContainer.protectionContainerName,
    targetProtectionContainerId: base.recoveryContainer.protectionContainerId,
    policyId: base.policy.policyId,
    providerSpecificInput: { instanceType: "A2A", agentAutoUpdateStatus: "Disabled" },
  });
  const rg = base.group.resourceGroupName;

  // Primary VM in the primary region.
  const vnet = yield* Azure.Network.VirtualNetwork("PrimaryVnet", {
    resourceGroup: rg,
    location: PRIMARY,
    addressPrefixes: ["10.30.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("PrimarySubnet", {
    resourceGroup: rg,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.30.1.0/24",
  });
  const nic = yield* Azure.Network.NetworkInterface("Nic", {
    resourceGroup: rg,
    location: PRIMARY,
    ipConfigurations: [{ subnetId: subnet.subnetId }],
  });
  const vm = yield* Azure.Compute.VirtualMachine("Vm", {
    resourceGroup: rg,
    location: PRIMARY,
    vmSize: "Standard_F1als_v7",
    networkInterfaceIds: [nic.networkInterfaceId],
    adminUsername: "azureuser",
    sshPublicKeys: [PUBLIC_KEY],
  });

  // Cache storage in the primary region; targets in the recovery region.
  const cache = yield* Azure.Storage.StorageAccount("Cache", {
    resourceGroup: rg,
    location: PRIMARY,
    sku: "Standard_LRS",
    kind: "StorageV2",
  });
  const recoveryGroup = yield* Azure.Resources.ResourceGroup("RecoveryGroup", {
    location: RECOVERY,
  });
  const recoveryVnet = yield* Azure.Network.VirtualNetwork("RecoveryVnet", {
    resourceGroup: rg,
    location: RECOVERY,
    addressPrefixes: ["10.40.0.0/16"],
  });
  const recoverySubnet = yield* Azure.Network.Subnet("RecoverySubnet", {
    resourceGroup: rg,
    virtualNetwork: recoveryVnet.virtualNetworkName,
    addressPrefix: "10.40.1.0/24",
  });
  return {
    ...base,
    mapping,
    vm,
    cache,
    recoveryGroup,
    recoveryVnet,
    recoverySubnet,
  };
});

/** Replication stack plus an A2A protected item for its VM (~20 minutes). */
export const protectedItemStack = (recoveryAzureVMSize: string) =>
  Effect.gen(function* () {
    const base = yield* replicationStack;
    const item = yield* Azure.SiteRecovery.ProtectedItem("Item", {
      ...base.base,
      fabric: base.primary.fabricName,
      protectionContainer: base.primaryContainer.protectionContainerName,
      policyId: base.policy.policyId,
      providerSpecificDetails: {
        instanceType: "A2A",
        fabricObjectId: base.vm.virtualMachineId,
        recoveryContainerId: base.recoveryContainer.protectionContainerId,
        recoveryResourceGroupId: base.recoveryGroup.resourceGroupId,
        recoveryAzureNetworkId: base.recoveryVnet.virtualNetworkId,
        recoverySubnetName: base.recoverySubnet.subnetName,
        vmManagedDisks: [
          {
            diskId: base.vm.osDiskId.as<string>(),
            primaryStagingAzureStorageAccountId: base.cache.storageAccountId,
            recoveryResourceGroupId: base.recoveryGroup.resourceGroupId,
          },
        ],
      },
      recoveryAzureVMSize,
    });
    return { ...base, item };
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );
