import * as Run from "@alchemy.run/gcp/Run";
import * as Effect from "effect/Effect";
import {
  makePoolLayer,
  nodeEnvironment,
  NODE_DOCKERFILE,
  type PoolSettings,
} from "../internal/PoolHost.ts";

export interface WorkerPoolOptions extends PoolSettings {
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * Region of the worker pool.
   * @default the control plane's region, or the stack's
   */
  location?: string;
  /**
   * CPU of each node (Cloud Run quantity, e.g. `"1"`).
   * @default "1"
   */
  cpu?: string;
  /**
   * Memory of each node (e.g. `"1Gi"`).
   * @default "1Gi"
   */
  memory?: string;
}

/**
 * Run a pool's nodes on a Cloud Run worker pool: a pool on the control
 * plane, and a worker pool whose instances host every `Rivet.DurableObject`
 * given this pool. Worker pools serve no requests and keep a fixed number
 * of instances running, which is what a node is: it only connects out to
 * the control plane. Works with any control plane it can reach —
 * `RivetGCP.ComputeControlPlane`, `RivetCloud.ControlPlane`, or one on
 * another cloud.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Cloud Run
 * **Example:** Two nodes
 * ```typescript
 * export const Cluster = RivetGCP.ComputeControlPlane("Rivet");
 * export const Default = RivetGCP.WorkerPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const WorkerPool = (id: string, options: WorkerPoolOptions = {}) =>
  makePoolLayer({
    label: "RivetGCP.WorkerPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    // Worker pools reach the internet without a VPC of their own.
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    nodes: (nodes) =>
      Effect.gen(function* () {
        const location =
          options.location ?? (nodes.network?.kind === "gcp" ? nodes.network.region : undefined);
        // Every class the pool hosts is bundled into its node image.
        yield* Run.WorkerPool(`${id}Nodes`, {
          ...nodes.program,
          dockerfile: { content: NODE_DOCKERFILE },
          ...(location === undefined ? {} : { location }),
          scaling: { manualInstanceCount: options.replicas ?? 1 },
          template: {
            containers: [
              {
                resources: {
                  limits: { cpu: options.cpu ?? "1", memory: options.memory ?? "1Gi" },
                },
              },
            ],
          },
          env: nodeEnvironment(nodes),
        });
      }),
  });
