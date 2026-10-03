import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameText } from "./Common.ts";

export interface ClusterIdentity {
  /** Kind of managed identity attached to the cluster. */
  type: "SystemAssigned" | "UserAssigned" | "SystemAssigned,UserAssigned" | "None";
  /** ARM resource IDs of user-assigned identities. */
  userAssignedIdentities?: string[];
}

export interface ClusterKeyVaultProperties {
  /** URI of the Key Vault that holds the customer-managed key. */
  keyVaultUri: string;
  /** Name of the key. */
  keyName: string;
  /** Version of the key; omit to follow the latest version. */
  keyVersion?: string;
  /** RSA key size (2048, 3072, or 4096). */
  keyRsaSize?: number;
}

export interface ClusterProps {
  /**
   * Resource group the cluster is created in. Changing it replaces the
   * cluster.
   */
  resourceGroup: string;
  /**
   * Cluster name: 4-63 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Daily commitment tier in GB (100, 200, 300, 400, 500, 1000, 2000,
   * 5000, 10000, 25000, 50000). Can be raised at any time and lowered
   * after 31 days.
   * @default 100
   */
  capacity?: number;
  /**
   * Who is billed for the commitment: the cluster, or the linked
   * workspaces in proportion to their ingestion.
   * @default "Cluster"
   */
  billingType?: "Cluster" | "Workspaces";
  /**
   * Managed identity of the cluster, used to reach a customer-managed key.
   * @default { type: "SystemAssigned" }
   */
  identity?: ClusterIdentity;
  /** Customer-managed key for data encryption. */
  keyVaultProperties?: ClusterKeyVaultProperties;
  /**
   * Encrypt data twice (infrastructure encryption). Changing it replaces
   * the cluster.
   */
  isDoubleEncryptionEnabled?: boolean;
  /**
   * Spread the cluster across availability zones, where the region
   * supports it. Changing it replaces the cluster.
   */
  isAvailabilityZonesEnabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.LogAnalytics.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the cluster; link workspaces with it. */
    clusterId: string;
    /** GUID of the cluster (`properties.clusterId`). */
    clusterGuid: string | undefined;
    /** Location of the cluster. */
    location: string;
    /** Daily commitment tier in GB. */
    capacity: number | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** ARM resource IDs of the workspaces linked to the cluster. */
    associatedWorkspaces: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dedicated Log Analytics cluster: a commitment tier of at least
 * 100 GB/day that linked workspaces ingest into, adding customer-managed
 * keys, double encryption, availability zones, and cross-workspace query
 * speedups. Link workspaces with `Azure.LogAnalytics.LinkedService`
 * (`name: "cluster"`).
 *
 * **Cost:** billing starts when the cluster is created — about $200+ per
 * day at the minimum 100 GB/day tier, with a 31-day minimum commitment.
 * Provisioning can take up to two hours. A deleted cluster stays
 * soft-deleted for 14 days and its name is reserved meanwhile.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/logs-dedicated-clusters
 *
 * ### Creating a Cluster
 * **Example:** Minimum commitment tier
 * ```typescript
 * const cluster = yield* Azure.LogAnalytics.Cluster("logs-cluster", {
 *   resourceGroup: group.resourceGroupName,
 *   capacity: 100,
 * });
 * yield* Azure.LogAnalytics.LinkedService("cluster-link", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   name: "cluster",
 *   writeAccessResourceId: cluster.clusterId,
 * });
 * ```
 *
 * ### Customer-Managed Keys
 * **Example:** Encrypt with a Key Vault key
 * ```typescript
 * const cluster = yield* Azure.LogAnalytics.Cluster("logs-cluster", {
 *   resourceGroup: group.resourceGroupName,
 *   keyVaultProperties: {
 *     keyVaultUri: "https://my-vault.vault.azure.net",
 *     keyName: "logs-key",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.LogAnalytics.Cluster");

type ObservedCluster = operationalinsights.GetClusterResponse;

const createClusterName = (id: string) =>
  createPhysicalName({ id, maxLength: 63 }).pipe(
    Effect.map((name) => name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")),
  );

const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetCluster({
      subscriptionId,
      resourceGroupName,
      clusterName,
    }),
  ).pipe(
    Effect.map((cluster) =>
      cluster?.properties?.provisioningState === "Deleting"
        ? undefined
        : cluster,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): Cluster["Attributes"] => ({
  clusterName: name,
  resourceGroup,
  clusterId: cluster.id ?? "",
  clusterGuid: cluster.properties?.clusterId,
  location: cluster.location,
  capacity: cluster.sku?.capacity ?? undefined,
  principalId: cluster.identity?.principalId,
  associatedWorkspaces: (cluster.properties?.associatedWorkspaces ?? []).flatMap(
    (workspace) => (workspace.resourceId ? [workspace.resourceId] : []),
  ),
  tags: userTags(cluster.tags),
});

const toIdentity = (
  identity: ClusterIdentity,
): operationalinsights.ClustersCreateOrUpdateRequestIdentity => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const identityDiffers = (
  observed: operationalinsights.ClustersCreateOrUpdateResponseIdentity | undefined,
  desired: ClusterIdentity,
) => {
  if (!sameText(observed?.type ?? "None", desired.type)) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

const keyVaultDiffers = (
  observed: operationalinsights.KeyVaultProperties | undefined,
  desired: ClusterKeyVaultProperties,
) =>
  !sameText(
    observed?.keyVaultUri?.replace(/\/+$/, ""),
    desired.keyVaultUri.replace(/\/+$/, ""),
  ) ||
  !sameText(observed?.keyName, desired.keyName) ||
  (observed?.keyVersion ?? "") !== (desired.keyVersion ?? "") ||
  (desired.keyRsaSize !== undefined &&
    observed?.keyRsaSize !== desired.keyRsaSize);

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "resourceGroup", "clusterId", "clusterGuid"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* operationalinsights
        .ListClusters({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListClusters", page)));
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameText(news.name, output.clusterName)) ||
        (news.location !== undefined &&
          !sameText(
            news.location.replaceAll(" ", ""),
            output.location.replaceAll(" ", ""),
          )) ||
        (olds !== undefined &&
          ((news.isDoubleEncryptionEnabled ?? false) !==
            (olds.isDoubleEncryptionEnabled ?? false) ||
            (news.isAvailabilityZonesEnabled ?? false) !==
              (olds.isAvailabilityZonesEnabled ?? false)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const capacity = news.capacity ?? 100;
      const billingType = news.billingType ?? "Cluster";
      const identity = news.identity ?? { type: "SystemAssigned" as const };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const get = getCluster(subscriptionId, resourceGroup, name);
      // Provisioning a dedicated cluster can take up to two hours.
      const budget = { interval: "60 seconds", times: 60 } as const;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* operationalinsights.ClustersCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentity(identity),
          sku: { name: "CapacityReservation", capacity },
          properties: {
            billingType,
            isDoubleEncryptionEnabled: news.isDoubleEncryptionEnabled,
            isAvailabilityZonesEnabled: news.isAvailabilityZonesEnabled,
            keyVaultProperties: news.keyVaultProperties,
          },
        });
        observed = yield* waitForProvisioned(
          `Log Analytics cluster ${name}`,
          get,
          (cluster) => cluster.properties?.provisioningState,
          budget,
        );
      }

      // Sync capacity, billing, keys, identity, and tags against the
      // observed cluster; PATCH only the deltas.
      const skuDelta = observed.sku?.capacity !== capacity;
      const billingDelta = !sameText(
        observed.properties?.billingType,
        billingType,
      );
      const keyDelta =
        news.keyVaultProperties !== undefined &&
        keyVaultDiffers(
          observed.properties?.keyVaultProperties,
          news.keyVaultProperties,
        );
      const identityDelta = identityDiffers(observed.identity, identity);
      const tagDelta = tagsDiffer(observed.tags, tags);
      if (skuDelta || billingDelta || keyDelta || identityDelta || tagDelta) {
        yield* operationalinsights.UpdateCluster({
          ...where,
          sku: skuDelta ? { name: "CapacityReservation", capacity } : undefined,
          properties:
            billingDelta || keyDelta
              ? {
                  billingType: billingDelta ? billingType : undefined,
                  keyVaultProperties: keyDelta
                    ? news.keyVaultProperties
                    : undefined,
                }
              : undefined,
          identity: identityDelta ? toIdentity(identity) : undefined,
          tags: tagDelta ? tags : undefined,
        });
        observed = yield* waitForProvisioned(
          `Log Analytics cluster ${name}`,
          get,
          (cluster) => cluster.properties?.provisioningState,
          budget,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `Log Analytics cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "30 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
