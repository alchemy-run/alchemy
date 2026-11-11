import * as DO from "@distilled.cloud/digitalocean";
import type { KubernetesNodePool } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import type { Providers } from "../Providers.ts";
import { observeKubernetesCluster, waitUntilRunning } from "./Cluster.ts";
import { nodePoolBody, nodePoolInSync, type NodePoolSettings } from "./shared.ts";

export type NodePoolProps = NodePoolSettings & {
  /** The cluster. A change replaces the pool. */
  clusterId: string;
  /**
   * Pool name, unique in the cluster. A change renames the pool in place.
   *
   * @default a generated physical name
   */
  name?: string;
};

export type NodePool = Resource<
  "DigitalOcean.Kubernetes.NodePool",
  NodePoolProps,
  {
    /** Node pool id (UUID). */
    nodePoolId: string;
    /** The cluster. */
    clusterId: string;
    /** Pool name. */
    name: string;
    /** Droplet size slug of the nodes. */
    size: string;
    /** Number of nodes. */
    count: number;
    /** Names of the pool's nodes. */
    nodeNames: string[];
  },
  never,
  Providers
>;

export type NodePoolAttributes = NodePool["Attributes"];

/**
 * An extra node pool in a DigitalOcean Kubernetes cluster, for example
 * larger or GPU nodes that only some workloads schedule onto. Count,
 * autoscaling, labels, taints, tags and the name update in place; a new
 * `size` replaces the pool, creating the new one first.
 *
 * ### Adding a Node Pool
 * **Example:** A tainted pool for batch jobs
 * ```typescript
 * const cluster = yield* DigitalOcean.Kubernetes.Cluster("k8s", {
 *   region: "nyc3",
 *   nodePool: { size: "s-2vcpu-4gb", count: 2 },
 * });
 * yield* DigitalOcean.Kubernetes.NodePool("batch", {
 *   clusterId: cluster.clusterId,
 *   size: "c-8",
 *   count: 1,
 *   autoScale: true,
 *   minNodes: 0,
 *   maxNodes: 5,
 *   labels: { workload: "batch" },
 *   taints: [{ key: "workload", value: "batch", effect: "NoSchedule" }],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/kubernetes_add_nodePool
 *
 * @resource
 * @product Kubernetes
 * @category Containers
 */
export const NodePool = Resource<NodePool>("DigitalOcean.Kubernetes.NodePool");

export class NodePoolWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.Kubernetes.NodePoolWaitTimedOut",
)<{
  readonly nodePoolId: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Node pool ${this.nodePoolId} timed out waiting for ${this.waitingFor}.`;
  }
}

// Nodes take a few minutes to join (≈ 15 min budget).
const NODE_POLL: PollBudget = { maxDelay: "15 seconds", times: 64 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (clusterId: string, pool: KubernetesNodePool): NodePoolAttributes => ({
  nodePoolId: pool.id,
  clusterId,
  name: pool.name,
  size: pool.size,
  count: pool.count,
  nodeNames: (pool.nodes ?? []).flatMap((node) => (node.name ? [node.name] : [])),
});

const observeById = (clusterId: string, nodePoolId: string) =>
  noneIfNotFound(
    DO.getKubernetesNodePool({ cluster_id: clusterId, node_pool_id: nodePoolId }).pipe(
      Effect.map((r) => r.node_pool),
    ),
  );

const observeByName = (clusterId: string, name: string) =>
  observeKubernetesCluster(clusterId).pipe(
    Effect.map((cluster) =>
      Option.flatMapNullishOr(cluster, (c) => c.node_pools.find((p) => p.name === name)),
    ),
  );

const isReady = (pool: KubernetesNodePool) =>
  (pool.nodes ?? []).length >= pool.count &&
  (pool.nodes ?? []).every((node) => node.status?.state === "running");

export const NodePoolProvider = () =>
  Provider.succeed(NodePool, {
    stables: ["nodePoolId", "clusterId"],
    read: Effect.fn(function* ({ id, olds, output }) {
      const clusterId = output?.clusterId ?? olds.clusterId;
      if (output !== undefined) {
        const byId = yield* observeById(clusterId, output.nodePoolId);
        if (Option.isSome(byId)) return toAttrs(clusterId, byId.value);
      }
      const name = olds.name ?? (yield* physicalName(id));
      const byName = yield* observeByName(clusterId, name);
      return Option.getOrUndefined(Option.map(byName, (p) => toAttrs(clusterId, p)));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.clusterId !== olds.clusterId || news.size !== olds.size) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      yield* waitUntilRunning(news.clusterId);
      const byId =
        output === undefined
          ? Option.none()
          : yield* observeById(news.clusterId, output.nodePoolId);
      const observed = Option.isSome(byId) ? byId : yield* observeByName(news.clusterId, name);
      const pool = yield* Option.match(observed, {
        onNone: () =>
          DO.addKubernetesNodePool({
            cluster_id: news.clusterId,
            ...nodePoolBody(name, news),
          }).pipe(Effect.map((r) => r.node_pool)),
        onSome: Effect.succeed,
      });
      if (!nodePoolInSync(pool, name, news)) {
        const { size: _size, ...settings } = nodePoolBody(name, news);
        yield* DO.updateKubernetesNodePool({
          cluster_id: news.clusterId,
          node_pool_id: pool.id,
          ...settings,
        });
      }
      const ready = yield* pollUntil(observeById(news.clusterId, pool.id), {
        ...NODE_POLL,
        until: (o): o is Option.Some<KubernetesNodePool> =>
          Option.isSome(o) && o.value.name === name && isReady(o.value),
        onTimeout: () =>
          new NodePoolWaitTimedOut({ nodePoolId: pool.id, waitingFor: "its nodes to run" }),
      });
      return toAttrs(news.clusterId, ready.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteKubernetesNodePool({
          cluster_id: output.clusterId,
          node_pool_id: output.nodePoolId,
        }),
      );
      yield* pollUntil(observeById(output.clusterId, output.nodePoolId), {
        ...NODE_POLL,
        until: Option.isNone,
        onTimeout: () =>
          new NodePoolWaitTimedOut({ nodePoolId: output.nodePoolId, waitingFor: "deletion" }),
      });
    }),
  });
