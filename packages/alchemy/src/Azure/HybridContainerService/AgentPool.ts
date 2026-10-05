import * as aks from "@distilled.cloud/azure/hybridaks";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  CLUSTER_WAIT,
  HYBRID_AKS_NAMESPACE,
  type HybridAksExtendedLocation,
  matchesDesired,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

export interface AgentPoolProps {
  /**
   * ARM ID of the Arc-enabled Kubernetes cluster whose
   * `Azure.HybridContainerService.ProvisionedCluster` the pool belongs to
   * (its `connectedClusterId` attribute). Changing it replaces the pool.
   */
  connectedClusterId: string;
  /**
   * Name of the pool: lowercase letters and digits, starting with a letter,
   * at most 12 characters (6 for Windows pools). If omitted, a unique name
   * is generated. Changing it replaces the pool.
   */
  name?: string;
  /**
   * Arc custom location of the Azure Local cluster the node VMs run on;
   * usually the provisioned cluster's. Changing it replaces the pool.
   */
  extendedLocation?: HybridAksExtendedLocation;
  /**
   * Operating system of the nodes. Changing it replaces the pool.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows";
  /**
   * OS SKU of the nodes. Changing it replaces the pool.
   * @default "CBLMariner" for Linux, "Windows2019" for Windows
   */
  osSKU?: "CBLMariner" | "Windows2019" | "Windows2022";
  /**
   * VM size of the nodes, e.g. `Standard_A4_v2`. Changing it replaces the
   * pool.
   */
  vmSize?: string;
  /**
   * Maximum number of pods per node. Changing it replaces the pool.
   */
  maxPods?: number;
  /**
   * Number of nodes. Mutable (ignored by the service while autoscaling).
   * @default 1
   */
  count?: number;
  /**
   * Whether the cluster autoscaler manages the node count. Mutable.
   * @default false
   */
  enableAutoScaling?: boolean;
  /** Minimum node count when autoscaling. Mutable. */
  minCount?: number;
  /** Maximum node count when autoscaling. Mutable. */
  maxCount?: number;
  /** Kubernetes labels applied to every node. Mutable. */
  nodeLabels?: Record<string, string>;
  /** Taints applied to every node, e.g. `key=value:NoSchedule`. Mutable. */
  nodeTaints?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AgentPool extends Resource<
  "Azure.HybridContainerService.AgentPool",
  AgentPoolProps,
  {
    /** ARM resource ID of the pool. */
    agentPoolId: string;
    /** Name of the pool. */
    agentPoolName: string;
    /** ARM ID of the connected cluster the pool belongs to. */
    connectedClusterId: string;
    /** ARM ID of the Arc custom location hosting the nodes. */
    customLocationId: string | undefined;
    /** Observed node count. */
    count: number | undefined;
    /** Kubernetes version of the nodes (inherited from the cluster). */
    kubernetesVersion: string | undefined;
    /** Provisioning state of the latest operation. */
    provisioningState: string | undefined;
    /** Observed state of the pool. */
    currentState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A node pool of an AKS cluster on Azure Local (AKS enabled by Azure Arc):
 * a group of Linux or Windows node VMs of one size, with optional
 * autoscaling, labels and taints.
 *
 * @see https://learn.microsoft.com/azure/aks/aksarc/manage-node-pools
 *
 * ### Creating a Node Pool
 * **Example:** Linux pool
 * ```typescript
 * const pool = yield* Azure.HybridContainerService.AgentPool("pool", {
 *   connectedClusterId: cluster.connectedClusterId,
 *   extendedLocation: { name: customLocationId },
 *   osType: "Linux",
 *   vmSize: "Standard_A4_v2",
 *   count: 2,
 * });
 * ```
 *
 * ### Scaling and Scheduling
 * **Example:** Autoscaling pool with labels and taints
 * ```typescript
 * yield* Azure.HybridContainerService.AgentPool("gpu", {
 *   connectedClusterId: cluster.connectedClusterId,
 *   extendedLocation: { name: customLocationId },
 *   enableAutoScaling: true,
 *   minCount: 1,
 *   maxCount: 4,
 *   nodeLabels: { workload: "batch" },
 *   nodeTaints: ["workload=batch:NoSchedule"],
 *   tags: { team: "data" },
 * });
 * ```
 *
 * @resource
 */
export const AgentPool = Resource<AgentPool>(
  "Azure.HybridContainerService.AgentPool",
);

const IMMUTABLE_KEYS = ["osType", "osSKU", "vmSize", "maxPods"] as const;

const getAgentPool = (
  connectedClusterResourceUri: string,
  agentPoolName: string,
) =>
  orUndefinedIfNotFound(
    aks.GetAgentPool({ connectedClusterResourceUri, agentPoolName }),
  );

// `np` + 10 lowercase base32 characters: 12 chars, starts with a letter.
const createName = (id: string) =>
  createPhysicalName({
    id,
    prefix: "np",
    suffixLength: 10,
    maxLength: 12,
    lowercase: true,
    delimiter: "",
  });

const toAttrs = (
  connectedClusterId: string,
  name: string,
  value: aks.GetAgentPoolResponse,
): AgentPool["Attributes"] => ({
  agentPoolId: value.id ?? "",
  agentPoolName: name,
  connectedClusterId,
  customLocationId: value.extendedLocation?.name,
  count: value.properties?.count,
  kubernetesVersion: value.properties?.kubernetesVersion,
  provisioningState: value.properties?.provisioningState,
  currentState: value.properties?.status?.currentState,
  tags: userTags(value.tags),
});

export const AgentPoolProvider = () =>
  Provider.succeed(AgentPool, {
    stables: ["agentPoolId", "agentPoolName", "connectedClusterId"],

    // Pools vanish with the provisioned cluster they belong to.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.connectedClusterId, output.connectedClusterId) ||
        (news.name !== undefined && !sameId(news.name, output.agentPoolName)) ||
        (news.extendedLocation !== undefined &&
          output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined &&
          IMMUTABLE_KEYS.some((key) => !sameValue(news[key], olds[key])))
      ) {
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const connectedClusterId =
        output?.connectedClusterId ?? olds?.connectedClusterId;
      if (connectedClusterId === undefined) return undefined;
      const name =
        output?.agentPoolName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getAgentPool(connectedClusterId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(connectedClusterId, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HYBRID_AKS_NAMESPACE);
      const { connectedClusterId } = news;
      const name =
        news.name ?? output?.agentPoolName ?? (yield* createName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getAgentPool(connectedClusterId, name);
      const mutable = {
        count: news.count,
        enableAutoScaling: news.enableAutoScaling,
        minCount: news.minCount,
        maxCount: news.maxCount,
        nodeLabels: news.nodeLabels,
        nodeTaints: news.nodeTaints,
      };

      // Observe.
      const observed = yield* get;

      // Ensure / sync. No PATCH: one PUT carries the whole desired pool,
      // sent when the pool is missing, a user-specified mutable field
      // drifted, or the observed tags differ.
      if (
        observed === undefined ||
        !matchesDesired(mutable, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* aks.AgentPoolCreateOrUpdate({
          connectedClusterResourceUri: connectedClusterId,
          agentPoolName: name,
          tags,
          extendedLocation:
            news.extendedLocation === undefined
              ? observed?.extendedLocation
              : toExtendedLocation(news.extendedLocation),
          properties: {
            osType: news.osType,
            osSKU: news.osSKU,
            vmSize: news.vmSize,
            maxPods: news.maxPods,
            ...mutable,
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `AKS Arc agent pool ${connectedClusterId}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
        CLUSTER_WAIT,
      );
      return toAttrs(connectedClusterId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        aks.DeleteAgentPool({
          connectedClusterResourceUri: output.connectedClusterId,
          agentPoolName: output.agentPoolName,
        }),
      );
      yield* waitUntilGone(
        `AKS Arc agent pool ${output.connectedClusterId}/${output.agentPoolName}`,
        getAgentPool(output.connectedClusterId, output.agentPoolName),
        CLUSTER_WAIT,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridContainerService.ProvisionedCluster",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
