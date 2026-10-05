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
  deepMerge,
  sameName,
  subsetMatches,
  whileClusterBusy,
} from "./Common.ts";

export type AgentPoolMode = cs.AgentPoolMode;

export interface AgentPoolProps {
  /** Resource group of the cluster. Changing it replaces the pool. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the pool. */
  cluster: string;
  /**
   * Pool name: 1-12 lowercase letters and digits starting with a letter
   * (1-6 for Windows). If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the pool.
   */
  name?: string;
  /**
   * VM size of the nodes. Changing it replaces the pool. Allowed sizes vary
   * by region and subscription.
   * @default chosen by AKS for the region
   */
  vmSize?: string;
  /**
   * Pool mode. A cluster needs at least one `System` pool.
   * @default "User"
   */
  mode?: AgentPoolMode;
  /**
   * Number of nodes. `User` pools may scale to 0. Ignored while
   * `enableAutoScaling` is `true`.
   * @default 1
   */
  count?: number;
  /** Let the cluster autoscaler scale the pool between `minCount` and `maxCount`. */
  enableAutoScaling?: boolean;
  /** Minimum node count when autoscaling. */
  minCount?: number;
  /** Maximum node count when autoscaling. */
  maxCount?: number;
  /**
   * Node OS. Changing it replaces the pool.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows";
  /** Node OS SKU (e.g. `Ubuntu`, `AzureLinux`). Changing it replaces the pool. */
  osSKU?: cs.OSSKU;
  /** OS disk size in GiB. Changing it replaces the pool. */
  osDiskSizeGB?: number;
  /** Maximum pods per node. Changing it replaces the pool. */
  maxPods?: number;
  /** Availability zones of the nodes. Changing them replaces the pool. */
  availabilityZones?: string[];
  /** Subnet the nodes join. Changing it replaces the pool. */
  vnetSubnetId?: string;
  /**
   * Kubernetes version of the nodes (must not exceed the control plane).
   * Raising it upgrades the pool in place.
   * @default the control-plane version
   */
  orchestratorVersion?: string;
  /**
   * `Regular` or `Spot` VMs. Changing it replaces the pool.
   * @default "Regular"
   */
  scaleSetPriority?: "Regular" | "Spot";
  /** Maximum price for Spot VMs (`-1` = on-demand price). Changing it replaces the pool. */
  spotMaxPrice?: number;
  /** Kubernetes labels applied to every node. */
  nodeLabels?: Record<string, string>;
  /** Kubernetes taints applied to every node, e.g. `key=value:NoSchedule`. */
  nodeTaints?: string[];
  /**
   * Tags applied to the pool's scale set. Alchemy ownership tags are merged
   * in automatically.
   */
  tags?: Record<string, string>;
}

export interface AgentPool extends Resource<
  "Azure.ContainerService.AgentPool",
  AgentPoolProps,
  {
    /** Name of the pool. */
    agentPoolName: string;
    /** ARM resource ID of the pool. */
    agentPoolId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** VM size of the nodes. */
    vmSize: string | undefined;
    /** Pool mode (`System` / `User`). */
    mode: string | undefined;
    /** Current node count. */
    count: number | undefined;
    /** Kubernetes version the nodes run. */
    currentOrchestratorVersion: string | undefined;
    /** Node image version. */
    nodeImageVersion: string | undefined;
    /** Kubernetes labels on the nodes. */
    nodeLabels: Record<string, string>;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A node pool in an AKS managed cluster.
 *
 * AKS serializes operations on a cluster, so pools of the same cluster are
 * created one after another. `User` pools can be scaled to zero nodes.
 *
 * @see https://learn.microsoft.com/azure/aks/create-node-pools
 *
 * ### Adding Node Pools
 * **Example:** User pool with labels and taints
 * ```typescript
 * const pool = yield* Azure.ContainerService.AgentPool("workers", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   vmSize: "Standard_D4s_v5",
 *   count: 2,
 *   nodeLabels: { workload: "batch" },
 *   nodeTaints: ["workload=batch:NoSchedule"],
 * });
 * ```
 *
 * **Example:** Autoscaling Spot pool
 * ```typescript
 * const spot = yield* Azure.ContainerService.AgentPool("spot", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   scaleSetPriority: "Spot",
 *   spotMaxPrice: -1,
 *   enableAutoScaling: true,
 *   minCount: 0,
 *   maxCount: 5,
 * });
 * ```
 *
 * @resource
 */
export const AgentPool = Resource<AgentPool>(
  "Azure.ContainerService.AgentPool",
);

type ObservedPool = cs.GetAgentPoolResponse;

const createPoolName = (id: string) => createChildName(id, 12, "");

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  agentPoolName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetAgentPool({
      subscriptionId,
      resourceGroupName,
      resourceName,
      agentPoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  pool: ObservedPool,
): AgentPool["Attributes"] => {
  const props = pool.properties ?? {};
  return {
    agentPoolName: name,
    agentPoolId: pool.id ?? "",
    cluster,
    resourceGroup,
    vmSize: props.vmSize,
    mode: props.mode,
    count: props.count,
    currentOrchestratorVersion: props.currentOrchestratorVersion,
    nodeImageVersion: props.nodeImageVersion,
    nodeLabels: Object.fromEntries(
      Object.entries(props.nodeLabels ?? {}).flatMap(([k, v]) =>
        v === undefined ? [] : [[k, v]],
      ),
    ),
    tags: userTags(props.tags),
  };
};

/** Fields that can change in place. */
const mutableFields = (news: AgentPoolProps) => ({
  mode: news.mode ?? "User",
  ...(news.enableAutoScaling
    ? {
        enableAutoScaling: true,
        minCount: news.minCount,
        maxCount: news.maxCount,
      }
    : { enableAutoScaling: false, count: news.count ?? 1 }),
  nodeLabels: news.nodeLabels ?? {},
  nodeTaints: news.nodeTaints ?? [],
});

const stateOf = (pool: ObservedPool) => pool.properties?.provisioningState;

const isPending = (state: string | undefined) =>
  state !== undefined &&
  state !== "Succeeded" &&
  state !== "Failed" &&
  state !== "Canceled";

const sameRecord = (
  a: Record<string, string | undefined> | undefined,
  b: Record<string, string>,
) => !tagsDiffer(a, b);

export const AgentPoolProvider = () =>
  Provider.succeed(AgentPool, {
    stables: ["agentPoolName", "agentPoolId", "cluster", "resourceGroup"],

    // Pools live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.agentPoolName)
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const immutable = [
          [olds.vmSize, news.vmSize],
          [olds.osType ?? "Linux", news.osType ?? "Linux"],
          [olds.osSKU, news.osSKU],
          [olds.osDiskSizeGB, news.osDiskSizeGB],
          [olds.maxPods, news.maxPods],
          [olds.vnetSubnetId, news.vnetSubnetId],
          [
            olds.scaleSetPriority ?? "Regular",
            news.scaleSetPriority ?? "Regular",
          ],
          [olds.spotMaxPrice, news.spotMaxPrice],
          [
            (olds.availabilityZones ?? []).join(","),
            (news.availabilityZones ?? []).join(","),
          ],
        ] as const;
        if (
          immutable.some(
            ([a, b]) => String(a).toLowerCase() !== String(b).toLowerCase(),
          )
        ) {
          return { action: "replace" } as const;
        }
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
        output?.agentPoolName ?? olds?.name ?? (yield* createPoolName(id));
      const observed = yield* getPool(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isOwned(id, observed.properties?.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ?? output?.agentPoolName ?? (yield* createPoolName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: cluster,
        agentPoolName: name,
      };
      const label = `agent pool ${cluster}/${name}`;
      const get = getPool(subscriptionId, resourceGroup, cluster, name);
      const waitReady = waitForProvisioned(label, get, stateOf, {
        interval: "10 seconds",
        times: 60,
      });
      const mutable = mutableFields(news);

      // Observe.
      let observed = yield* get;
      if (observed !== undefined && isPending(stateOf(observed))) {
        observed = yield* waitReady;
      }

      // Ensure.
      if (observed === undefined) {
        yield* cs
          .AgentPoolsCreateOrUpdate({
            ...where,
            properties: {
              type: "VirtualMachineScaleSets",
              vmSize: news.vmSize,
              osType: news.osType ?? "Linux",
              osSKU: news.osSKU,
              osDiskSizeGB: news.osDiskSizeGB,
              maxPods: news.maxPods,
              availabilityZones: news.availabilityZones,
              vnetSubnetID: news.vnetSubnetId,
              scaleSetPriority: news.scaleSetPriority,
              spotMaxPrice: news.spotMaxPrice,
              orchestratorVersion: news.orchestratorVersion,
              ...mutable,
              tags,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      // Sync. A pool PUT replaces the whole pool, so the body is the
      // observed pool with the desired deltas applied.
      const props = observed.properties ?? {};
      const { nodeLabels, nodeTaints, ...scalars } = mutable;
      const versionDrift =
        news.orchestratorVersion !== undefined &&
        !(
          props.currentOrchestratorVersion ??
          props.orchestratorVersion ??
          ""
        ).startsWith(news.orchestratorVersion);
      const drift =
        versionDrift ||
        !subsetMatches(scalars, props) ||
        !sameRecord(props.nodeLabels, nodeLabels) ||
        [...(props.nodeTaints ?? [])].sort().join(",") !==
          [...nodeTaints].sort().join(",") ||
        tagsDiffer(props.tags, tags);
      if (drift) {
        yield* cs
          .AgentPoolsCreateOrUpdate({
            ...where,
            properties: {
              ...deepMerge<cs.ManagedClusterAgentPoolProfilePropertiesInput>(
                props,
                {
                  ...scalars,
                  orchestratorVersion: versionDrift
                    ? news.orchestratorVersion
                    : undefined,
                },
              ),
              nodeLabels,
              nodeTaints,
              tags,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteAgentPool({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.cluster,
            agentPoolName: output.agentPoolName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `agent pool ${output.cluster}/${output.agentPoolName}`,
        getPool(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.agentPoolName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
