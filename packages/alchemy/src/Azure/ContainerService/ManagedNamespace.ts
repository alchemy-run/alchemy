import * as cs from "@distilled.cloud/azure/containerservice";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  getCluster,
  sameName,
  subsetMatches,
  whileClusterBusy,
} from "./Common.ts";

export type NamespaceNetworkPolicyRule = cs.NetworkPoliciesIngress;

export interface ManagedNamespaceProps {
  /** Resource group of the cluster. Changing it replaces the namespace. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the namespace. */
  cluster: string;
  /**
   * Kubernetes namespace name: 1-63 lowercase letters, digits, and
   * hyphens. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the namespace.
   */
  name?: string;
  /** Kubernetes labels of the namespace. */
  labels?: Record<string, string>;
  /** Kubernetes annotations of the namespace. */
  annotations?: Record<string, string>;
  /**
   * Default resource quota of the namespace, as Kubernetes quantities. AKS
   * requires all four values, and CPU in milli-CPU form, e.g.
   * `{ cpuRequest: "500m", cpuLimit: "2000m", memoryRequest: "512Mi", memoryLimit: "2Gi" }`.
   */
  defaultResourceQuota?: cs.ResourceQuota;
  /** Default ingress / egress network policy of the namespace. */
  defaultNetworkPolicy?: {
    /** Ingress rule. */
    ingress?: NamespaceNetworkPolicyRule;
    /** Egress rule. */
    egress?: NamespaceNetworkPolicyRule;
  };
  /**
   * Whether an existing Kubernetes namespace of the same name is taken
   * over: `Never`, `IfIdentical`, or `Always`.
   * @default "Never"
   */
  adoptionPolicy?: cs.AdoptionPolicy;
  /**
   * Whether deleting the ARM resource deletes the Kubernetes namespace
   * (`Delete`) or leaves it (`Keep`).
   * @default "Delete"
   */
  deletePolicy?: cs.DeletePolicy;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedNamespace extends Resource<
  "Azure.ContainerService.ManagedNamespace",
  ManagedNamespaceProps,
  {
    /** Kubernetes namespace name. */
    namespaceName: string;
    /** ARM resource ID of the namespace; use it as an Azure RBAC scope. */
    namespaceId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Location of the namespace (the cluster's). */
    location: string;
    /** Azure portal FQDN of the namespace. */
    portalFqdn: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AKS managed namespace: a Kubernetes namespace governed through ARM,
 * with a default resource quota and network policy, and Azure RBAC
 * role assignments scoped to it.
 *
 * The cluster must use Microsoft Entra ID with Azure RBAC
 * (`aad: { enableAzureRbac: true }`).
 *
 * @see https://learn.microsoft.com/azure/aks/concepts-managed-namespaces
 *
 * ### Creating Namespaces
 * **Example:** Team namespace with a quota and deny-all ingress
 * ```typescript
 * const team = yield* Azure.ContainerService.ManagedNamespace("team-a", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   name: "team-a",
 *   labels: { team: "a" },
 *   defaultResourceQuota: {
 *     cpuRequest: "2000m",
 *     cpuLimit: "4000m",
 *     memoryRequest: "4Gi",
 *     memoryLimit: "8Gi",
 *   },
 *   defaultNetworkPolicy: { ingress: "AllowSameNamespace", egress: "AllowAll" },
 * });
 * ```
 *
 * @resource
 */
export const ManagedNamespace = Resource<ManagedNamespace>(
  "Azure.ContainerService.ManagedNamespace",
);

type ObservedNamespace = cs.GetManagedNamespaceResponse;

const createNamespaceName = (id: string) => createChildName(id, 63);

const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  managedNamespaceName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetManagedNamespace({
      subscriptionId,
      resourceGroupName,
      resourceName,
      managedNamespaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  namespace: ObservedNamespace,
): ManagedNamespace["Attributes"] => ({
  namespaceName: name,
  namespaceId: namespace.id ?? "",
  cluster,
  resourceGroup,
  location: namespace.location,
  portalFqdn: namespace.properties?.portalFqdn,
  tags: userTags(namespace.tags),
});

const desiredProperties = (
  news: ManagedNamespaceProps,
): cs.NamespacePropertiesInput => ({
  labels: news.labels ?? {},
  annotations: news.annotations ?? {},
  defaultResourceQuota: news.defaultResourceQuota,
  defaultNetworkPolicy: news.defaultNetworkPolicy,
  adoptionPolicy: news.adoptionPolicy ?? "Never",
  deletePolicy: news.deletePolicy ?? "Delete",
});

const stateOf = (namespace: ObservedNamespace) =>
  namespace.properties?.provisioningState;

const propertiesMatch = (
  desired: cs.NamespacePropertiesInput,
  observed: ObservedNamespace["properties"],
) => {
  const { labels, annotations, ...rest } = desired;
  return (
    subsetMatches(rest, observed) &&
    !tagsDiffer(observed?.labels, labels ?? {}) &&
    !tagsDiffer(observed?.annotations, annotations ?? {})
  );
};

export const ManagedNamespaceProvider = () =>
  Provider.succeed(ManagedNamespace, {
    stables: ["namespaceName", "namespaceId", "cluster", "resourceGroup"],

    // Namespaces live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.namespaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined)
        return undefined;
      const name =
        output?.namespaceName ?? olds?.name ?? (yield* createNamespaceName(id));
      const observed = yield* getNamespace(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ?? output?.namespaceName ?? (yield* createNamespaceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const desired = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: cluster,
        managedNamespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, cluster, name);
      const waitReady = waitForProvisioned(
        `managed namespace ${cluster}/${name}`,
        get,
        stateOf,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync properties: the PUT is a full upsert of the namespace.
      if (
        observed === undefined ||
        !propertiesMatch(desired, observed.properties)
      ) {
        // A namespace lives in its cluster's location.
        const location =
          observed?.location ??
          (yield* getCluster(subscriptionId, resourceGroup, cluster))
            ?.location ??
          (yield* AzureEnvironment.current).location;
        yield* cs
          .ManagedNamespacesCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: desired,
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* cs
          .UpdateManagedNamespace({ ...where, tags })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteManagedNamespace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.cluster,
            managedNamespaceName: output.namespaceName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `managed namespace ${output.cluster}/${output.namespaceName}`,
        getNamespace(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.namespaceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
