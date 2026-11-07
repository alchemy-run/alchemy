import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import {
  bundleNodes,
  isImageProgram,
  makePoolLayer,
  nodeEnvironment,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";
import { RunnerPool, type RunnerMachineType } from "./RunnerPool.ts";

export interface PoolOptions extends PoolSettings {
  /**
   * The region the nodes run in. It must be enabled on the cluster.
   * @default the cluster's first region
   */
  region?: string;
  /**
   * The machine each node runs on. The cluster's plan caps it: the free plan
   * allows `e2-micro` and `e2-small`.
   * @default "e2-small"
   */
  machineType?: RunnerMachineType;
  /**
   * The number of nodes. The cluster's plan caps it across all its pools:
   * one on the free plan.
   * @default 1
   */
  nodeCount?: number;
}

/**
 * Run a pool's nodes on Rivet Cloud: a pool on the cluster's control plane,
 * and a Rivet Cloud runner pool whose nodes host every `Rivet.DurableObject`
 * given this pool. Requires a `RivetCloud.ControlPlane`.
 *
 * Each deploy whose classes changed builds a Docker image of the node
 * program with the local `docker` CLI and uploads it to Rivet Cloud, so
 * deploying needs Docker. Rivet Cloud runner pools take no environment of
 * their own: the stage's namespace and the classes' environment, secrets
 * included, are baked into the image Rivet stores.
 *
 * Rivet Cloud runs one runner pool per cluster for now, so one stage at a
 * time can host its nodes there: a second stage's deploy is refused, as the
 * runner pool belongs to another. Give other stages a cluster of their own,
 * or a pool on another cloud.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Rivet Cloud
 * **Example:** Rivet runs the control plane and the nodes
 * ```typescript
 * export const Cluster = RivetCloud.ControlPlane("Rivet");
 * export const Default = RivetCloud.Pool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * **Example:** A bigger machine
 * ```typescript
 * export const Default = RivetCloud.Pool("Default", { machineType: "e2-medium" }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const Pool = (id: string, options: PoolOptions = {}) =>
  makePoolLayer({
    label: "RivetCloud.Pool",
    id,
    settings: options,
    expected: "a Rivet Cloud cluster (RivetCloud.ControlPlane)",
    network: (cluster): { readonly cluster: Input<string> } | undefined =>
      cluster.rivetCloudCluster === undefined ? undefined : { cluster: cluster.rivetCloudCluster },
    // Every class the pool hosts is bundled into the node program, which
    // Rivet Cloud runs from an image with RivetKit installed beside it.
    nodes: Effect.fn(function* (nodes) {
      const stack = yield* Stack;
      // What every alchemy runtime host sets; the node program reads it.
      const env = nodeEnvironment(nodes).pipe(
        Output.map((values) => ({
          ...values,
          ALCHEMY_STACK_NAME: stack.name,
          ALCHEMY_STAGE: stack.stage,
          ALCHEMY_PHASE: "runtime",
        })),
      );
      yield* RunnerPool(`${id}Nodes`, {
        cluster: nodes.network.cluster as string,
        region: options.region,
        // A Rust program is its own image, built from its staged crate.
        ...(isImageProgram(nodes.program)
          ? { context: nodes.program.context }
          : {
              main: (yield* bundleNodes("rivet-cloud", id, nodes.program)) as unknown as string,
              rivetkitVersion: RIVETKIT_VERSION,
            }),
        env: env as unknown as Record<string, string>,
        machineType: options.machineType,
        nodeCount: options.nodeCount,
      });
    }),
  });
