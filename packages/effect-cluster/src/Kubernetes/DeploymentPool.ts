import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";

export interface DeploymentPoolOptions extends PoolSettings {
  /**
   * Number of runners.
   * @default 2
   */
  replicas?: number;
  /**
   * How the gateway's Service is exposed. `ClusterIP` serves callers in the
   * cluster; `LoadBalancer` serves callers anywhere, where the cluster
   * provisions load balancers.
   * @default "ClusterIP"
   */
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /** Container CPU/memory requests and limits. */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /**
   * CPU architecture of the runner image, built on the deploying machine.
   * @default the cluster's
   */
  architecture?: "amd64" | "arm64";
}

/**
 * Run a pool of Effect Cluster runners on Kubernetes: a Deployment whose pods
 * host every class given this pool, in the database's cluster and
 * namespace. Pods reach each other at their own addresses; the gateway is
 * a Service of the Deployment, at
 * `http://{name}.{namespace}.svc.cluster.local:34500` for callers in the
 * cluster. Requires a database on a Kubernetes cluster —
 * `ClusterKubernetes.Database`.
 *
 * ### Running on Kubernetes
 * **Example:** Two runners
 * ```typescript
 * export const Database = ClusterKubernetes.Database("Cluster", { cluster: Kind });
 * export const Default = ClusterKubernetes.DeploymentPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * @primitive
 */
export const DeploymentPool = (id: string, options: DeploymentPoolOptions = {}) =>
  makePoolLayer({
    label: "ClusterKubernetes.DeploymentPool",
    id,
    settings: options,
    expected: "a Kubernetes cluster (ClusterKubernetes.Database)",
    network: (database) => (database.network?.kind === "kubernetes" ? database.network : undefined),
    // The Deployment's Service is named after the pool.
    gateway: (name, network) =>
      Effect.succeed({
        url: `http://${name}.${network.namespace}.svc.cluster.local:${GATEWAY_PORT}`,
      }),
    nodes: ({ network, name, program, environment }) =>
      Kubernetes.Deployment(`${id}Pool`, {
        cluster: network.cluster as Kubernetes.ClusterLike,
        name,
        namespace: network.namespace,
        context: program.pipe(Output.map((p) => p.dir)) as unknown as string,
        replicas: options.replicas ?? 2,
        port: GATEWAY_PORT,
        serviceType: options.serviceType ?? "ClusterIP",
        ...(options.resources === undefined ? {} : { resources: options.resources }),
        ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
        env: environment as unknown as Record<string, string>,
      }).pipe(Effect.asVoid),
  });
