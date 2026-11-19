import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import {
  bundleNodes,
  isImageProgram,
  makePoolLayer,
  nodeEnvironment,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";

export interface ServicePoolOptions extends PoolSettings {
  /**
   * Railway Project the nodes run in. Defaults to a Project of the pool's
   * own.
   */
  project?: Railway.ServiceProps["project"];
  /**
   * Railway region of the nodes, such as `us-west2`.
   * @default the workspace's default region
   */
  region?: string;
}

/**
 * Run a pool's nodes on Railway: a pool on the control plane, and a
 * Railway Service that runs every `Rivet.DurableObject` given this pool.
 * Nodes only connect out to the control plane, so the Service has no
 * public domain and works with any control plane it can reach —
 * `RivetCloud.ControlPlane`, or one on another cloud.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Railway
 * **Example:** Nodes on Railway, control plane on Fly
 * ```typescript
 * export const Cluster = RivetFly.MachineControlPlane("Rivet");
 * export const Default = RivetRailway.ServicePool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicePool = (id: string, options: ServicePoolOptions = {}) =>
  makePoolLayer({
    label: "RivetRailway.ServicePool",
    id,
    settings: options,
    expected: "a reachable control plane",
    // Railway services reach the control plane's public address.
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    // Every class the pool hosts is bundled into the node program;
    // RivetKit is installed beside it (it loads a native addon).
    nodes: Effect.fn(function* (nodes) {
      const project = options.project ?? (yield* Railway.Project(`${id}Project`, {}));
      yield* Railway.Service(`${id}Nodes`, {
        project,
        // A Rust program is its own image: Railway builds its staged crate.
        ...(isImageProgram(nodes.program)
          ? { context: nodes.program.context }
          : {
              main: (yield* bundleNodes("railway", id, nodes.program)) as unknown as string,
              build: { install: { rivetkit: RIVETKIT_VERSION } },
            }),
        publicDomain: false,
        region: options.region,
        env: nodeEnvironment(nodes),
      });
    }),
  });
