import * as discovery from "@distilled.cloud/azure/discovery";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import {
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  idSetKey,
  lower,
  sameLocation,
  toIdentityMap,
} from "./common.ts";

export interface SupercomputerProps {
  /**
   * Resource group the supercomputer is created in. Changing it replaces
   * the supercomputer.
   */
  resourceGroup: string;
  /**
   * Supercomputer name: 3-24 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the supercomputer.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the supercomputer.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Subnet of the system node pool; must reach the node pool subnets.
   * Changing it replaces the supercomputer.
   */
  subnetId: string;
  /**
   * Subnet of the AKS API server, delegated to
   * `Microsoft.ContainerService/managedClusters`. Changing it replaces the
   * supercomputer.
   */
  managementSubnetId?: string;
  /**
   * Egress type of the supercomputer workloads. Changing it replaces the
   * supercomputer.
   * @default "LoadBalancer"
   */
  outboundType?: "LoadBalancer" | "None";
  /** VM size of the system node pool. Changing it replaces the supercomputer. */
  systemSku?: string;
  /**
   * ARM ID of the user-assigned cluster identity. Changing it replaces the
   * supercomputer.
   */
  clusterIdentity: string;
  /**
   * ARM ID of the user-assigned kubelet identity; it needs the Managed
   * Identity Operator role on the cluster identity. Changing it replaces
   * the supercomputer.
   */
  kubeletIdentity: string;
  /**
   * ARM IDs of user-assigned identities that workloads use as federated
   * credentials.
   */
  workloadIdentities?: string[];
  /**
   * Encrypt data at rest with a customer-managed key. Changing it replaces
   * the supercomputer.
   * @default "Disabled"
   */
  customerManagedKeys?: "Enabled" | "Disabled";
  /**
   * Disk encryption set for customer-managed keys. Changing it replaces the
   * supercomputer.
   */
  diskEncryptionSetId?: string;
  /**
   * Log Analytics cluster for debug logs (required with customer-managed
   * keys). Changing it replaces the supercomputer.
   */
  logAnalyticsClusterId?: string;
  /**
   * Enable a system-assigned managed identity on the supercomputer.
   * @default false
   */
  systemAssignedIdentity?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Supercomputer extends Resource<
  "Azure.Discovery.Supercomputer",
  SupercomputerProps,
  {
    /** Name of the supercomputer. */
    supercomputerName: string;
    /** ARM resource ID of the supercomputer. */
    supercomputerId: string;
    /** Resource group that holds the supercomputer. */
    resourceGroup: string;
    /** Location of the supercomputer. */
    location: string;
    /** Resource group Azure manages for the supercomputer's AKS cluster. */
    managedResourceGroup: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery supercomputer (`Microsoft.Discovery/supercomputers`)
 * — managed AKS-based compute that runs Discovery tools; add GPU capacity
 * with `Azure.Discovery.NodePool`.
 *
 * Provisioning takes 30+ minutes and the system node pool needs regional
 * vCPU quota. Microsoft Discovery is a gated preview: on subscriptions
 * without the preview, ARM rejects the resource type with
 * `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Supercomputer
 * **Example:** Supercomputer on an existing virtual network
 * ```typescript
 * const supercomputer = yield* Azure.Discovery.Supercomputer("hpc", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: systemSubnet.subnetId,
 *   managementSubnetId: apiServerSubnet.subnetId,
 *   clusterIdentity: clusterIdentity.identityId,
 *   kubeletIdentity: kubeletIdentity.identityId,
 * });
 * ```
 *
 * ### Workload Identities
 * **Example:** Federated workload identity
 * ```typescript
 * const supercomputer = yield* Azure.Discovery.Supercomputer("hpc", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: systemSubnet.subnetId,
 *   clusterIdentity: clusterIdentity.identityId,
 *   kubeletIdentity: kubeletIdentity.identityId,
 *   workloadIdentities: [workloadIdentity.identityId],
 * });
 * ```
 *
 * @resource
 */
export const Supercomputer = Resource<Supercomputer>(
  "Azure.Discovery.Supercomputer",
);

/**
 * Without the Discovery preview ARM rejects the type itself
 * (`InvalidResourceType`): no supercomputer can exist there.
 */
export const getSupercomputer = (
  subscriptionId: string,
  resourceGroupName: string,
  supercomputerName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetSupercomputer({
      subscriptionId,
      resourceGroupName,
      supercomputerName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    discovery.GetSupercomputerResponse,
    "id" | "location" | "properties" | "tags" | "identity"
  >,
): Supercomputer["Attributes"] => ({
  supercomputerName: name,
  supercomputerId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  managedResourceGroup: observed.properties?.managedResourceGroup,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const identityType = (enabled: boolean | undefined) =>
  enabled ? "SystemAssigned" : "None";

export const SupercomputerProvider = () =>
  Provider.succeed(Supercomputer, {
    stables: [
      "supercomputerName",
      "supercomputerId",
      "resourceGroup",
      "location",
      "managedResourceGroup",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* discovery
        .ListSupercomputerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSupercomputerBySubscription", page),
          ),
          Effect.catchTag("InvalidResourceType", () =>
            Effect.succeed(undefined),
          ),
        );
      return (page?.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.supercomputerName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.subnetId) !== lower(olds?.subnetId) ||
        lower(news.managementSubnetId) !== lower(olds?.managementSubnetId) ||
        (news.outboundType ?? "LoadBalancer") !==
          (olds?.outboundType ?? "LoadBalancer") ||
        lower(news.systemSku) !== lower(olds?.systemSku) ||
        lower(news.clusterIdentity) !== lower(olds?.clusterIdentity) ||
        lower(news.kubeletIdentity) !== lower(olds?.kubeletIdentity) ||
        (news.customerManagedKeys ?? "Disabled") !==
          (olds?.customerManagedKeys ?? "Disabled") ||
        lower(news.diskEncryptionSetId) !== lower(olds?.diskEncryptionSetId) ||
        lower(news.logAnalyticsClusterId) !== lower(olds?.logAnalyticsClusterId)
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
        output?.supercomputerName ??
        olds?.name ??
        (yield* createDiscoveryName(id));
      const observed = yield* getSupercomputer(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.supercomputerName ??
        (yield* createDiscoveryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        supercomputerName: name,
      };
      const get = getSupercomputer(subscriptionId, resourceGroup, name);
      // 30+ minutes: the supercomputer provisions a managed AKS cluster.
      const ready = waitForProvisioned(
        `discovery supercomputer ${name}`,
        get,
        (supercomputer) => supercomputer.properties?.provisioningState,
        { interval: "60 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* discovery.SupercomputersCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: { type: identityType(news.systemAssignedIdentity) },
          properties: {
            subnetId: news.subnetId,
            managementSubnetId: news.managementSubnetId,
            outboundType: news.outboundType,
            systemSku: news.systemSku,
            identities: {
              clusterIdentity: { id: news.clusterIdentity },
              kubeletIdentity: { id: news.kubeletIdentity },
              workloadIdentities: toIdentityMap(news.workloadIdentities),
            },
            customerManagedKeys: news.customerManagedKeys,
            diskEncryptionSetId: news.diskEncryptionSetId,
            logAnalyticsClusterId: news.logAnalyticsClusterId,
          },
        });
      }
      observed = yield* ready;

      // Sync workload identities, the managed identity, and tags.
      const workloadChanged =
        news.workloadIdentities !== undefined &&
        idSetKey(news.workloadIdentities) !==
          idSetKey(
            Object.keys(
              observed.properties?.identities.workloadIdentities ?? {},
            ),
          );
      const identityChanged =
        lower(observed.identity?.type ?? "None") !==
        lower(identityType(news.systemAssignedIdentity));
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (workloadChanged || identityChanged || tagsChanged) {
        yield* discovery.UpdateSupercomputer({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged
            ? { type: identityType(news.systemAssignedIdentity) }
            : undefined,
          properties: workloadChanged
            ? {
                identities: {
                  workloadIdentities:
                    toIdentityMap(news.workloadIdentities) ?? {},
                },
              }
            : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteSupercomputer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          supercomputerName: output.supercomputerName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery supercomputer ${output.supercomputerName}`,
        getSupercomputer(
          subscriptionId,
          output.resourceGroup,
          output.supercomputerName,
        ),
        { interval: "60 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
