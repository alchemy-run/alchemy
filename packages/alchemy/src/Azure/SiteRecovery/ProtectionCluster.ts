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
  ownedOrUnowned,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

export interface ProtectionClusterProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the cluster. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the cluster. */
  vault: string;
  /** Name of the primary fabric. Changing it replaces the cluster. */
  fabric: string;
  /** Name of the primary protection container. Changing it replaces the cluster. */
  protectionContainer: string;
  /**
   * Protection cluster name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /** ARM ID of the replication policy. Changing it replaces the cluster. */
  policyId: string;
  /**
   * Cluster type. Changing it replaces the cluster.
   * @default "SharedDisk"
   */
  protectionClusterType?: string;
  /**
   * Provider-specific cluster details, e.g. `{ instanceType: "A2A",
   * clusterManagementId, multiVmGroupName, ... }`. Changing them replaces
   * the cluster.
   */
  providerSpecificDetails: { instanceType: string; [key: string]: unknown };
  /** Agent cluster ID. Changing it replaces the cluster. */
  agentClusterId?: string;
  /** Cluster FQDN. Changing it replaces the cluster. */
  clusterFqdn?: string;
  /** FQDNs of the cluster nodes. Changing them replaces the cluster. */
  clusterNodeFqdns?: string[];
  /** ARM IDs of the protected items of the cluster nodes. Changing them replaces the cluster. */
  clusterProtectedItemIds?: string[];
}

export interface ProtectionCluster extends Resource<
  "Azure.SiteRecovery.ProtectionCluster",
  ProtectionClusterProps,
  {
    /** Name of the protection cluster. */
    protectionClusterName: string;
    /** Name of the primary protection container. */
    protectionContainer: string;
    /** Name of the primary fabric. */
    fabric: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the protection cluster. */
    protectionClusterId: string;
    /** ARM ID of the replication policy. */
    policyId: string;
    /** Protection state of the cluster. */
    protectionState: string | undefined;
    /** Replication health of the cluster. */
    replicationHealth: string | undefined;
    /** Provisioning state of the cluster. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery replication protection cluster: replicates a
 * shared-disk VM cluster (e.g. Windows Server Failover Cluster nodes that
 * share a managed disk) to the recovery region as one unit (A2A).
 *
 * Protection clusters cannot be tagged; Alchemy treats a cluster as owned
 * when its vault is tagged for the current stack and stage. There is no
 * update API, so every change replaces the cluster, and delete is the
 * purge operation. Requires two or more VMs sharing a Premium SSD shared
 * disk, each already a {@link ProtectedItem}.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-protection-clusters/create
 *
 * ### Shared-Disk Clusters
 * **Example:** Protect a two-node shared-disk cluster
 * ```typescript
 * yield* Azure.SiteRecovery.ProtectionCluster("sql-cluster", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   fabric: primary.fabricName,
 *   protectionContainer: primaryContainer.protectionContainerName,
 *   policyId: policy.policyId,
 *   providerSpecificDetails: {
 *     instanceType: "A2A",
 *     multiVmGroupName: "sql-cluster",
 *   },
 *   clusterProtectedItemIds: [node1.protectedItemId, node2.protectedItemId],
 * });
 * ```
 *
 * @resource
 */
export const ProtectionCluster = Resource<ProtectionCluster>(
  "Azure.SiteRecovery.ProtectionCluster",
);

type Observed = asr.GetReplicationProtectionClusterResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  fabricName: string;
  protectionContainerName: string;
  replicationProtectionClusterName: string;
}

const getCluster = (where: Where) =>
  orUndefinedIfNotFound(asr.GetReplicationProtectionCluster(where));

const toAttrs = (
  where: Where,
  observed: Observed,
  policyId: string,
): ProtectionCluster["Attributes"] => ({
  protectionClusterName: where.replicationProtectionClusterName,
  protectionContainer: where.protectionContainerName,
  fabric: where.fabricName,
  vault: where.resourceName,
  resourceGroup: where.resourceGroupName,
  protectionClusterId: observed.id ?? "",
  policyId: observed.properties?.policyId ?? policyId,
  protectionState: observed.properties?.protectionState,
  replicationHealth: observed.properties?.replicationHealth,
  provisioningState: observed.properties?.provisioningState,
});

export const ProtectionClusterProvider = () =>
  Provider.succeed(ProtectionCluster, {
    stables: [
      "protectionClusterName",
      "protectionContainer",
      "fabric",
      "vault",
      "resourceGroup",
      "protectionClusterId",
    ],

    // Clusters live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const { name: _n, ...newRest } = news;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.fabric, output.fabric) ||
        !sameName(news.protectionContainer, output.protectionContainer) ||
        (news.name !== undefined &&
          !sameName(news.name, output.protectionClusterName)) ||
        (olds !== undefined &&
          JSON.stringify(newRest) !==
            JSON.stringify((({ name: _o, ...rest }) => rest)(olds)))
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
        replicationProtectionClusterName:
          output?.protectionClusterName ??
          olds?.name ??
          (yield* createSiteRecoveryName(id)),
      };
      const observed = yield* getCluster(where);
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
        replicationProtectionClusterName:
          news.name ??
          output?.protectionClusterName ??
          (yield* createSiteRecoveryName(id)),
      };
      const get = getCluster(where);

      // Observe; ensure (no update API: every change is a replacement).
      const observed = yield* get;
      if (observed === undefined) {
        yield* asr.CreateReplicationProtectionCluster({
          ...where,
          properties: compact({
            protectionClusterType: news.protectionClusterType ?? "SharedDisk",
            policyId: news.policyId,
            providerSpecificDetails: news.providerSpecificDetails,
            agentClusterId: news.agentClusterId,
            clusterFqdn: news.clusterFqdn,
            clusterNodeFqdns: news.clusterNodeFqdns,
            clusterProtectedItemIds: news.clusterProtectedItemIds,
          }),
        });
      }
      const fresh = yield* waitForProvisioned(
        `site recovery protection cluster ${where.replicationProtectionClusterName}`,
        get,
        (cluster) => cluster.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(where, fresh, news.policyId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.vault,
        fabricName: output.fabric,
        protectionContainerName: output.protectionContainer,
        replicationProtectionClusterName: output.protectionClusterName,
      };
      // Purge is the only delete operation for protection clusters.
      yield* ignoreNotFound(asr.PurgeReplicationProtectionCluster(where));
      yield* waitUntilGone(
        `site recovery protection cluster ${output.protectionClusterName}`,
        getCluster(where),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
