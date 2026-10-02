import * as discovery from "@distilled.cloud/azure/discovery";
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
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  lower,
  sameLocation,
} from "./common.ts";
import { getSupercomputer } from "./Supercomputer.ts";

export interface NodePoolProps {
  /**
   * Resource group of the parent supercomputer. Changing it replaces the
   * node pool.
   */
  resourceGroup: string;
  /** Name of the parent supercomputer. Changing it replaces the node pool. */
  supercomputer: string;
  /**
   * Node pool name: 3-24 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the node pool.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the node pool.
   * @default the parent supercomputer's location
   */
  location?: string;
  /** Subnet of the node pool. Changing it replaces the node pool. */
  subnetId: string;
  /**
   * GPU VM size, e.g. `Standard_NC24ads_A100_v4`. Changing it replaces the
   * node pool.
   */
  vmSize: string;
  /** Maximum number of nodes (at least 1). */
  maxNodeCount: number;
  /**
   * Minimum number of nodes.
   * @default 0
   */
  minNodeCount?: number;
  /**
   * Scale set priority. Changing it replaces the node pool.
   * @default "Regular"
   */
  scaleSetPriority?: "Regular" | "Spot";
  /**
   * OS disk size in GB. Changing it replaces the node pool.
   * @default 120
   */
  osDiskSizeGb?: number;
  /**
   * Disk usage percent below which image garbage collection never runs.
   * Changing it replaces the node pool.
   */
  imageCacheLowerThreshold?: number;
  /**
   * Disk usage percent above which image garbage collection always runs.
   * Changing it replaces the node pool.
   */
  imageCacheUpperThreshold?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NodePool extends Resource<
  "Azure.Discovery.NodePool",
  NodePoolProps,
  {
    /** Name of the node pool. */
    nodePoolName: string;
    /** ARM resource ID of the node pool. */
    nodePoolId: string;
    /** Name of the parent supercomputer. */
    supercomputer: string;
    /** Resource group that holds the node pool. */
    resourceGroup: string;
    /** Location of the node pool. */
    location: string;
    /** VM size of the nodes. */
    vmSize: string;
    /** Maximum number of nodes. */
    maxNodeCount: number;
    /** Minimum number of nodes. */
    minNodeCount: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery node pool
 * (`Microsoft.Discovery/supercomputers/nodePools`) — an autoscaling set of
 * GPU nodes in a Discovery supercomputer.
 *
 * Only GPU VM sizes are supported (A100 nodes cost ~$3.7/hour each, T4
 * nodes ~$0.53/hour). Microsoft Discovery is a gated preview: on
 * subscriptions without the preview, ARM rejects the resource type with
 * `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Node Pool
 * **Example:** Scale-to-zero A100 pool
 * ```typescript
 * const gpus = yield* Azure.Discovery.NodePool("a100", {
 *   resourceGroup: group.resourceGroupName,
 *   supercomputer: supercomputer.supercomputerName,
 *   subnetId: nodeSubnet.subnetId,
 *   vmSize: "Standard_NC24ads_A100_v4",
 *   minNodeCount: 0,
 *   maxNodeCount: 4,
 * });
 * ```
 *
 * **Example:** Spot T4 pool
 * ```typescript
 * const gpus = yield* Azure.Discovery.NodePool("t4", {
 *   resourceGroup: group.resourceGroupName,
 *   supercomputer: supercomputer.supercomputerName,
 *   subnetId: nodeSubnet.subnetId,
 *   vmSize: "Standard_NC4as_T4_v3",
 *   scaleSetPriority: "Spot",
 *   maxNodeCount: 2,
 * });
 * ```
 *
 * @resource
 */
export const NodePool = Resource<NodePool>("Azure.Discovery.NodePool");

const getNodePool = (
  subscriptionId: string,
  resourceGroupName: string,
  supercomputerName: string,
  nodePoolName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetNodePool({
      subscriptionId,
      resourceGroupName,
      supercomputerName,
      nodePoolName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  supercomputer: string,
  name: string,
  observed: discovery.GetNodePoolResponse,
): NodePool["Attributes"] => ({
  nodePoolName: name,
  nodePoolId: observed.id ?? "",
  supercomputer,
  resourceGroup,
  location: observed.location,
  vmSize: observed.properties?.vmSize ?? "",
  maxNodeCount: observed.properties?.maxNodeCount ?? 0,
  minNodeCount: observed.properties?.minNodeCount,
  tags: userTags(observed.tags),
});

export const NodePoolProvider = () =>
  Provider.succeed(NodePool, {
    stables: [
      "nodePoolName",
      "nodePoolId",
      "supercomputer",
      "resourceGroup",
      "location",
      "vmSize",
    ],

    // Node pools live inside a supercomputer; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.supercomputer) !== lower(output.supercomputer) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.nodePoolName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.vmSize) !== lower(output.vmSize) ||
        lower(news.subnetId) !== lower(olds?.subnetId) ||
        (news.scaleSetPriority ?? "Regular") !==
          (olds?.scaleSetPriority ?? "Regular") ||
        news.osDiskSizeGb !== olds?.osDiskSizeGb ||
        news.imageCacheLowerThreshold !== olds?.imageCacheLowerThreshold ||
        news.imageCacheUpperThreshold !== olds?.imageCacheUpperThreshold
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const supercomputer = output?.supercomputer ?? olds?.supercomputer;
      if (resourceGroup === undefined || supercomputer === undefined) {
        return undefined;
      }
      const name =
        output?.nodePoolName ?? olds?.name ?? (yield* createDiscoveryName(id));
      const observed = yield* getNodePool(
        subscriptionId,
        resourceGroup,
        supercomputer,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, supercomputer, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const { resourceGroup, supercomputer } = news;
      const name =
        news.name ?? output?.nodePoolName ?? (yield* createDiscoveryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const minNodeCount = news.minNodeCount ?? 0;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        supercomputerName: supercomputer,
        nodePoolName: name,
      };
      const get = getNodePool(
        subscriptionId,
        resourceGroup,
        supercomputer,
        name,
      );
      const ready = waitForProvisioned(
        `discovery node pool ${name}`,
        get,
        (pool) => pool.properties?.provisioningState,
        { interval: "20 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getSupercomputer(
            subscriptionId,
            resourceGroup,
            supercomputer,
          ))?.location ??
          env.location;
        yield* discovery.NodePoolsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            subnetId: news.subnetId,
            vmSize: news.vmSize,
            maxNodeCount: news.maxNodeCount,
            minNodeCount,
            scaleSetPriority: news.scaleSetPriority,
            osDiskSizeGb: news.osDiskSizeGb,
            imageCacheLowerThreshold: news.imageCacheLowerThreshold,
            imageCacheUpperThreshold: news.imageCacheUpperThreshold,
          },
        });
      }
      observed = yield* ready;

      // Sync the node counts and tags with a PATCH of the deltas.
      const props = observed.properties;
      const maxChanged = props?.maxNodeCount !== news.maxNodeCount;
      const minChanged = (props?.minNodeCount ?? 0) !== minNodeCount;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (maxChanged || minChanged || tagsChanged) {
        yield* discovery.UpdateNodePool({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties:
            maxChanged || minChanged
              ? {
                  maxNodeCount: maxChanged ? news.maxNodeCount : undefined,
                  minNodeCount: minChanged ? minNodeCount : undefined,
                }
              : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, supercomputer, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteNodePool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          supercomputerName: output.supercomputer,
          nodePoolName: output.nodePoolName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery node pool ${output.nodePoolName}`,
        getNodePool(
          subscriptionId,
          output.resourceGroup,
          output.supercomputer,
          output.nodePoolName,
        ),
        { interval: "20 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Discovery.Supercomputer",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
