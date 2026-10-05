import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  createSiteRecoveryName,
  matchesDesired,
  ownedOrUnowned,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

/** A managed disk to replicate (A2A). */
export interface ProtectedItemManagedDisk {
  /** ARM ID of the source managed disk. */
  diskId: string;
  /** Cache (staging) storage account in the source region. */
  primaryStagingAzureStorageAccountId: string;
  /** Resource group the replica disk is created in. */
  recoveryResourceGroupId: string;
  /** Replica disk type, e.g. `Standard_LRS`. */
  recoveryReplicaDiskAccountType?: string;
  /** Disk type of the failed-over disk, e.g. `Standard_LRS`. */
  recoveryTargetDiskAccountType?: string;
  /** Any other provider field. */
  [key: string]: unknown;
}

/**
 * Provider-specific enable-protection input. The documented fields are the
 * Azure-to-Azure (`A2A`) ones; other providers' fields are passed through.
 */
export interface ProtectedItemProviderInput {
  /** Replication provider, e.g. `A2A`. */
  instanceType: string;
  /** ARM ID of the VM to protect (A2A). */
  fabricObjectId?: string;
  /** ARM ID of the recovery protection container (A2A). */
  recoveryContainerId?: string;
  /** ARM ID of the resource group failed-over VMs are created in (A2A). */
  recoveryResourceGroupId?: string;
  /** ARM ID of the recovery virtual network (A2A). */
  recoveryAzureNetworkId?: string;
  /** Recovery subnet name (A2A). */
  recoverySubnetName?: string;
  /** Managed disks to replicate (A2A). */
  vmManagedDisks?: ProtectedItemManagedDisk[];
  /** Any other provider field. */
  [key: string]: unknown;
}

export interface ProtectedItemProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the item. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the item. */
  vault: string;
  /** Name of the primary fabric. Changing it replaces the item. */
  fabric: string;
  /** Name of the primary protection container. Changing it replaces the item. */
  protectionContainer: string;
  /**
   * Protected item name, unique within the container. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the item.
   */
  name?: string;
  /** ARM ID of the replication policy. Changing it replaces the item. */
  policyId: string;
  /** ARM ID of the protectable item (not used by A2A). Changing it replaces the item. */
  protectableItemId?: string;
  /** Enable-protection input. Changing it replaces the item. */
  providerSpecificDetails: ProtectedItemProviderInput;
  /** Name of the VM created on failover. Updated in place. */
  recoveryAzureVMName?: string;
  /** Size of the VM created on failover, e.g. `Standard_B1s`. Updated in place. */
  recoveryAzureVMSize?: string;
  /** ARM ID of the network failed-over VMs attach to. Updated in place. */
  selectedRecoveryAzureNetworkId?: string;
  /** ARM ID of the network test-failover VMs attach to. Updated in place. */
  selectedTfoAzureNetworkId?: string;
}

export interface ProtectedItem extends Resource<
  "Azure.SiteRecovery.ProtectedItem",
  ProtectedItemProps,
  {
    /** Name of the protected item. */
    protectedItemName: string;
    /** Name of the primary protection container. */
    protectionContainer: string;
    /** Name of the primary fabric. */
    fabric: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the protected item; reference it from a recovery plan. */
    protectedItemId: string;
    /** ARM ID of the replication policy. */
    policyId: string;
    /** Protection state, e.g. `UnprotectedStatesBegin` then `Protected`. */
    protectionState: string | undefined;
    /** Replication health, e.g. `Normal`. */
    replicationHealth: string | undefined;
    /** Active location, `Primary` or `Recovery`. */
    activeLocation: string | undefined;
    /** Failover health. */
    failoverHealth: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery replication protected item: enables replication
 * of a VM (Azure-to-Azure) from the primary container to the recovery
 * region under a replication policy.
 *
 * Protected items cannot be tagged; Alchemy treats an item as owned when
 * its vault is tagged for the current stack and stage. Reconcile returns
 * once the item exists; initial replication continues in the background
 * (30-60+ minutes) while `protectionState` progresses to `Protected`. The
 * failover VM name/size and recovery networks update in place; delete
 * disables replication gracefully. Protection is billed per instance
 * (first 31 days free) plus replica and cache storage.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-protected-items/create
 *
 * ### Azure-to-Azure Disaster Recovery
 * **Example:** Replicate a VM with one managed disk
 * ```typescript
 * const item = yield* Azure.SiteRecovery.ProtectedItem("web-vm", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   fabric: primary.fabricName,
 *   protectionContainer: primaryContainer.protectionContainerName,
 *   policyId: policy.policyId,
 *   providerSpecificDetails: {
 *     instanceType: "A2A",
 *     fabricObjectId: vm.vmId,
 *     recoveryContainerId: recoveryContainer.protectionContainerId,
 *     recoveryResourceGroupId: recoveryGroup.resourceGroupId,
 *     vmManagedDisks: [
 *       {
 *         diskId: vm.osDiskId,
 *         primaryStagingAzureStorageAccountId: cache.storageAccountId,
 *         recoveryResourceGroupId: recoveryGroup.resourceGroupId,
 *       },
 *     ],
 *   },
 *   recoveryAzureVMSize: "Standard_B1s",
 * });
 * ```
 *
 * @resource
 */
export const ProtectedItem = Resource<ProtectedItem>(
  "Azure.SiteRecovery.ProtectedItem",
);

type Observed = asr.GetReplicationProtectedItemResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  fabricName: string;
  protectionContainerName: string;
  replicatedProtectedItemName: string;
}

const getItem = (where: Where) =>
  orUndefinedIfNotFound(asr.GetReplicationProtectedItem(where));

const detailsOf = (observed: Observed) =>
  (observed.properties?.providerSpecificDetails ?? {}) as Record<
    string,
    unknown
  >;

const updatableOf = (news: ProtectedItemProps) =>
  compact({
    recoveryAzureVMName: news.recoveryAzureVMName,
    recoveryAzureVMSize: news.recoveryAzureVMSize,
    selectedRecoveryAzureNetworkId: news.selectedRecoveryAzureNetworkId,
    selectedTfoAzureNetworkId: news.selectedTfoAzureNetworkId,
  });

/** Enabling fails terminally with a `*Failed` protection state. */
const enableState = (observed: Observed) => {
  const state = observed.properties?.protectionState;
  return state !== undefined && /failed/i.test(state) ? "Failed" : undefined;
};

const toAttrs = (
  where: Where,
  observed: Observed,
  policyId: string,
): ProtectedItem["Attributes"] => ({
  protectedItemName: where.replicatedProtectedItemName,
  protectionContainer: where.protectionContainerName,
  fabric: where.fabricName,
  vault: where.resourceName,
  resourceGroup: where.resourceGroupName,
  protectedItemId: observed.id ?? "",
  policyId: observed.properties?.policyId ?? policyId,
  protectionState: observed.properties?.protectionState,
  replicationHealth: observed.properties?.replicationHealth,
  activeLocation: observed.properties?.activeLocation,
  failoverHealth: observed.properties?.failoverHealth,
});

export const ProtectedItemProvider = () =>
  Provider.succeed(ProtectedItem, {
    stables: [
      "protectedItemName",
      "protectionContainer",
      "fabric",
      "vault",
      "resourceGroup",
      "protectedItemId",
    ],

    // Protected items live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.fabric, output.fabric) ||
        !sameName(news.protectionContainer, output.protectionContainer) ||
        (news.name !== undefined &&
          !sameName(news.name, output.protectedItemName)) ||
        !sameName(news.policyId, output.policyId) ||
        (olds !== undefined &&
          ((news.protectableItemId ?? "") !== (olds.protectableItemId ?? "") ||
            JSON.stringify(news.providerSpecificDetails) !==
              JSON.stringify(olds.providerSpecificDetails)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const props = output ?? olds;
      if (props === undefined) return undefined;
      const where: Where = {
        subscriptionId,
        resourceGroupName: props.resourceGroup,
        resourceName: props.vault,
        fabricName: props.fabric,
        protectionContainerName: props.protectionContainer,
        replicatedProtectedItemName:
          output?.protectedItemName ??
          olds?.name ??
          (yield* createSiteRecoveryName(id)),
      };
      const observed = yield* getItem(where);
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(where, observed, props.policyId),
        output !== undefined,
        subscriptionId,
        props.resourceGroup,
        props.vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.vault,
        fabricName: news.fabric,
        protectionContainerName: news.protectionContainer,
        replicatedProtectedItemName:
          news.name ??
          output?.protectedItemName ??
          (yield* createSiteRecoveryName(id)),
      };
      const get = getItem(where);

      // Observe.
      let observed = yield* get;

      // Ensure: enable replication when missing; return once the item
      // exists (initial replication keeps running in the background).
      if (observed === undefined) {
        yield* asr.CreateReplicationProtectedItem({
          ...where,
          properties: compact({
            policyId: news.policyId,
            protectableItemId: news.protectableItemId,
            providerSpecificDetails: news.providerSpecificDetails,
          }),
        });
      }
      observed = yield* waitForProvisioned(
        `site recovery protected item ${where.replicatedProtectedItemName}`,
        get,
        enableState,
        { interval: "10 seconds", times: 60 },
      );

      // Sync: failover VM settings against the observed replication details.
      const desired = updatableOf(news);
      if (
        Object.keys(desired).length > 0 &&
        !matchesDesired(detailsOf(observed), desired)
      ) {
        yield* asr.UpdateReplicationProtectedItem({
          ...where,
          properties: {
            ...desired,
            providerSpecificDetails: {
              instanceType: news.providerSpecificDetails.instanceType,
            },
          },
        });
        observed = yield* waitForProvisioned(
          `site recovery protected item ${where.replicatedProtectedItemName}`,
          get,
          (item) =>
            matchesDesired(detailsOf(item), desired)
              ? enableState(item)
              : "Updating",
          { interval: "10 seconds", times: 36 },
        );
      }
      return toAttrs(where, observed, news.policyId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.vault,
        fabricName: output.fabric,
        protectionContainerName: output.protectionContainer,
        replicatedProtectedItemName: output.protectedItemName,
      };
      // Graceful disable (POST .../remove) cleans up replica disks.
      yield* ignoreNotFound(
        asr.DeleteReplicationProtectedItem({
          ...where,
          properties: { disableProtectionReason: "NotSpecified" },
        }),
      );
      yield* waitUntilGone(
        `site recovery protected item ${output.protectedItemName}`,
        getItem(where),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.SiteRecovery.RecoveryPlan",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
