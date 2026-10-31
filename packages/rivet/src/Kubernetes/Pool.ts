import * as Kubernetes from "@alchemy.run/kubernetes";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import {
  makePoolLayer,
  nodeEnvironment,
  NODE_DOCKERFILE,
  type PoolSettings,
} from "../internal/PoolHost.ts";

export interface PoolOptions extends PoolSettings {
  /**
   * The cluster to run the nodes on. Omit it to run them on the control
   * plane's own cluster (`RivetKubernetes.ControlPlane`); give it to run
   * them on another cluster, which reaches the control plane at its public
   * endpoint.
   */
  cluster?: Kubernetes.ClusterLike | Effect.Effect<Input<Kubernetes.ClusterLike>, never, any>;
  /**
   * Kubernetes namespace of the nodes.
   * @default the control plane's, or "default"
   */
  namespace?: string;
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
  /** Container CPU/memory requests and limits. */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /**
   * CPU architecture of the node image, built on the deploying machine.
   * @default the cluster's
   */
  architecture?: "amd64" | "arm64";
}

/**
 * Run a pool's nodes on Kubernetes: a pool on the control plane, and a
 * Deployment whose pods host every `Rivet.DurableObject` given this pool.
 * Nodes only connect out to the control plane, so they need no Service of
 * their own. On the control plane's own cluster they connect inside it;
 * on another cluster, at the control plane's public endpoint.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Kubernetes
 * **Example:** Nodes beside the control plane
 * ```typescript
 * export const Cluster = RivetKubernetes.ControlPlane("Rivet", { cluster: EksCluster });
 * export const Default = RivetKubernetes.Pool("Default", { replicas: 3 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * **Example:** Nodes on another cluster, against Rivet Cloud
 * ```typescript
 * export const Default = RivetKubernetes.Pool("Default", { cluster: GkeCluster }).pipe(
 *   Layer.provide(RivetCloud.ControlPlane()),
 * );
 * ```
 *
 * @primitive
 */
export const Pool = (id: string, options: PoolOptions = {}) =>
  makePoolLayer({
    label: "RivetKubernetes.Pool",
    id,
    settings: options,
    expected: "a Kubernetes cluster (RivetKubernetes.ControlPlane, or the `cluster` option)",
    network: (cluster) =>
      options.cluster !== undefined
        ? { kind: "external" as const, cluster: options.cluster, namespace: options.namespace }
        : cluster.network?.kind === "kubernetes"
          ? cluster.network
          : undefined,
    nodes: (nodes) =>
      Effect.gen(function* () {
        const { network } = nodes;
        const target = network.cluster as PoolOptions["cluster"] & {};
        const cluster = Effect.isEffect(target) ? yield* target : target;
        // Nodes on the control plane's cluster connect inside it; others at
        // its public endpoint.
        const endpoint =
          network.kind === "external" ? nodes.cluster.endpoint : nodes.environment.RIVET_ENDPOINT;
        // Every class the pool hosts is bundled into its node image.
        yield* Kubernetes.Deployment(`${id}Nodes`, {
          ...nodes.program,
          cluster,
          dockerfile: { content: NODE_DOCKERFILE },
          namespace: options.namespace ?? network.namespace ?? "default",
          replicas: options.replicas ?? 1,
          serviceType: "ClusterIP",
          ...(options.resources === undefined ? {} : { resources: options.resources }),
          ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
          env: nodeEnvironment(nodes, endpoint),
        });
      }),
  });
