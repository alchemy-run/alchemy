import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
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
  createDataReplicationName,
  DATA_REPLICATION_NAMESPACE,
  type DataReplicationCustomProperties,
  matchesDesired,
  ownedByVaultOrUnowned,
  sameName,
} from "./Shared.ts";

export interface ProtectedItemProps {
  /** Resource group of the vault. Changing it replaces the protected item. */
  resourceGroup: string;
  /** Name of the data replication vault. Changing it replaces the protected item. */
  vault: string;
  /**
   * Name of the protected item: letters and digits only. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the protected item.
   */
  name?: string;
  /** Name of the replication policy in the vault. Changing it replaces the protected item. */
  policyName: string;
  /**
   * Name of the replication extension in the vault. Changing it replaces
   * the protected item.
   */
  replicationExtensionName: string;
  /**
   * Machine-specific replication settings, discriminated by `instanceType`
   * (`HyperVToAzStackHCI` or `VMwareToAzStackHCI`): the discovered source
   * machine (`fabricDiscoveryMachineId`), target cluster and custom
   * location, target resource group, storage container, disks and NICs to
   * include, target VM size, and so on. Changing `instanceType` replaces
   * the protected item; other fields are patched in place.
   */
  customProperties: DataReplicationCustomProperties;
  /**
   * Delete the protected item even when the service cannot clean up the
   * replication on the source (e.g. the appliance is gone).
   * @default false
   */
  forceDelete?: boolean;
}

export interface ProtectedItem extends Resource<
  "Azure.DataReplication.ProtectedItem",
  ProtectedItemProps,
  {
    /** Name of the protected item. */
    protectedItemName: string;
    /** Name of the vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the protected item. */
    protectedItemId: string;
    /** Replication policy name. */
    policyName: string | undefined;
    /** Replication extension name. */
    replicationExtensionName: string | undefined;
    /** Replication protection state, e.g. `Protected`. */
    protectionState: string | undefined;
    /** Replication health: `Normal`, `Warning`, or `Critical`. */
    replicationHealth: string | undefined;
    /** Name of the replicated source machine. */
    fabricObjectName: string | undefined;
    /** Provisioning state of the protected item. */
    provisioningState: string | undefined;
    /** Whether deletion forces cleanup. */
    forceDelete: boolean;
  },
  never,
  Providers
> {}

/**
 * A protected (replicated) machine in an Azure Site Recovery data
 * replication vault
 * (`Microsoft.DataReplication/replicationVaults/protectedItems`): enables
 * replication of a discovered Hyper-V or VMware machine to Azure Local
 * through a replication extension under a replication policy.
 *
 * Protecting a machine needs a discovered source machine behind a
 * registered appliance and an Azure Local target cluster. Billed per
 * protected instance.
 *
 * Protected items cannot be tagged; Alchemy treats one as owned when its
 * vault is tagged for the current stack and stage.
 *
 * @see https://learn.microsoft.com/rest/api/datareplication/protected-item/create
 *
 * ### Protecting a Machine
 * **Example:** Replicate a Hyper-V VM to Azure Local
 * ```typescript
 * const item = yield* Azure.DataReplication.ProtectedItem("web01", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   policyName: policy.policyName,
 *   replicationExtensionName: extension.replicationExtensionName,
 *   customProperties: {
 *     instanceType: "HyperVToAzStackHCI",
 *     fabricDiscoveryMachineId: discoveredMachineId,
 *     targetHciClusterId: clusterId,
 *     targetArcClusterCustomLocationId: customLocationId,
 *     targetResourceGroupId: targetGroup.resourceGroupId,
 *     storageContainerId: storageContainerId,
 *     hyperVGeneration: "2",
 *     runAsAccountId: runAsAccountId,
 *     sourceDraName: "source-dra",
 *     targetDraName: "target-dra",
 *     customLocationRegion: "westus2",
 *     disksToInclude: [],
 *     nicsToInclude: [],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ProtectedItem = Resource<ProtectedItem>(
  "Azure.DataReplication.ProtectedItem",
);

type Observed = dr.GetProtectedItemResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  vaultName: string;
  protectedItemName: string;
}

const getItem = (where: Where) =>
  orUndefinedIfNotFound(dr.GetProtectedItem(where));

const customOf = (observed: Observed) =>
  (observed.properties?.customProperties ?? undefined) as
    | Record<string, unknown>
    | undefined;

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  forceDelete: boolean,
  observed: Observed,
): ProtectedItem["Attributes"] => ({
  protectedItemName: name,
  vault,
  resourceGroup,
  protectedItemId: observed.id ?? "",
  policyName: observed.properties?.policyName,
  replicationExtensionName: observed.properties?.replicationExtensionName,
  protectionState: observed.properties?.protectionState,
  replicationHealth: observed.properties?.replicationHealth,
  fabricObjectName: observed.properties?.fabricObjectName,
  provisioningState: observed.properties?.provisioningState,
  forceDelete,
});

export const ProtectedItemProvider = () =>
  Provider.succeed(ProtectedItem, {
    stables: ["protectedItemName", "vault", "resourceGroup", "protectedItemId"],

    // A vault child that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        (news.name !== undefined &&
          !sameName(news.name, output.protectedItemName)) ||
        (output.policyName !== undefined &&
          !sameName(news.policyName, output.policyName)) ||
        (output.replicationExtensionName !== undefined &&
          !sameName(
            news.replicationExtensionName,
            output.replicationExtensionName,
          )) ||
        (olds !== undefined &&
          !sameName(
            news.customProperties.instanceType,
            olds.customProperties.instanceType,
          ))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const name =
        output?.protectedItemName ??
        olds?.name ??
        (yield* createDataReplicationName(id));
      const observed = yield* getItem({
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: vault,
        protectedItemName: name,
      });
      if (observed === undefined) return undefined;
      return yield* ownedByVaultOrUnowned(
        toAttrs(
          resourceGroup,
          vault,
          name,
          output?.forceDelete ?? olds?.forceDelete ?? false,
          observed,
        ),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const name =
        news.name ??
        output?.protectedItemName ??
        (yield* createDataReplicationName(id));
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        vaultName: news.vault,
        protectedItemName: name,
      };
      const get = getItem(where);
      const settle = waitForProvisioned(
        `data replication protected item ${name}`,
        get,
        (item) => item.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dr.CreateProtectedItem({
          ...where,
          properties: {
            policyName: news.policyName,
            replicationExtensionName: news.replicationExtensionName,
            customProperties: news.customProperties,
          },
        });
        observed = yield* settle;
      }

      // Sync machine settings against observed state.
      if (!matchesDesired(customOf(observed), news.customProperties)) {
        yield* dr.UpdateProtectedItem({
          ...where,
          properties: { customProperties: news.customProperties },
        });
        observed = yield* settle;
      }

      return toAttrs(
        news.resourceGroup,
        news.vault,
        name,
        news.forceDelete ?? false,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.vault,
        protectedItemName: output.protectedItemName,
      };
      yield* ignoreNotFound(
        dr.DeleteProtectedItem({
          ...where,
          forceDelete: output.forceDelete || undefined,
        }),
      );
      // Disabling replication cleans up on the appliance and can take a
      // while.
      yield* waitUntilGone(
        `data replication protected item ${output.protectedItemName}`,
        getItem(where),
        { interval: "15 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.DataReplication.Vault"] },
  });
