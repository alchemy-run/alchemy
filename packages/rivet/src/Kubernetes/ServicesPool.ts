import * as Kubernetes from "@alchemy.run/kubernetes";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import {
  makeServicesLayer,
  servicesEnvironment,
  type ServicesPoolSettings,
} from "../internal/ServicesHost.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * The cluster to run the Services nodes on. Omit it to run them on the
   * control plane's own cluster (`RivetKubernetes.StatefulSetControlPlane`).
   */
  cluster?: Kubernetes.ClusterLike | Effect.Effect<Input<Kubernetes.ClusterLike>, never, any>;
  /**
   * Kubernetes namespace of the nodes.
   * @default the control plane's, or "default"
   */
  namespace?: string;
  /**
   * Number of Services nodes.
   * @default 1
   */
  replicas?: number;
  /** Container CPU/memory requests and limits. */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

/**
 * Run Rivet Services on Kubernetes: the `services` pool on the control
 * plane, and a Deployment running Rivet's prebuilt Services node, which
 * hosts Durable Streams and agentOS. Its Pods only connect out: callers
 * reach every stream through the control plane's gateway, with its token.
 *
 * ### Running Rivet Services on Kubernetes
 * **Example:** Services on the control plane's cluster
 * ```typescript
 * export const Cluster = RivetKubernetes.StatefulSetControlPlane("Rivet", { cluster });
 * export const Services = RivetKubernetes.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (id: string, options: ServicesPoolOptions = {}) =>
  makeServicesLayer({
    label: "RivetKubernetes.ServicesPool",
    id,
    settings: options,
    expected:
      "a Kubernetes cluster (RivetKubernetes.StatefulSetControlPlane, or the `cluster` option)",
    network: (cluster) =>
      options.cluster !== undefined
        ? { kind: "external" as const, cluster: options.cluster, namespace: options.namespace }
        : cluster.network?.kind === "kubernetes"
          ? cluster.network
          : undefined,
    nodes: (nodes) =>
      Effect.gen(function* () {
        const { network } = nodes;
        const target = network.cluster as ServicesPoolOptions["cluster"] & {};
        const cluster = Effect.isEffect(target) ? yield* target : target;
        yield* Kubernetes.Deployment(`${id}Nodes`, {
          image: nodes.image,
          cluster,
          namespace: options.namespace ?? network.namespace ?? "default",
          replicas: options.replicas ?? 1,
          serviceType: "ClusterIP",
          ...(options.resources === undefined ? {} : { resources: options.resources }),
          env: servicesEnvironment(nodes),
        });
      }),
  });
