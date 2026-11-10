import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import {
  bundleNodes,
  isImageProgram,
  makePoolLayer,
  nodeEnvironment,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";

export interface MachinePoolOptions extends PoolSettings {
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * Fly region of the nodes.
   * @default "iad"
   */
  region?: string;
  /**
   * Machine size of each node.
   * @default { cpus: 1, memoryMb: 1024 }
   */
  guest?: Fly.MachineGuest;
}

/**
 * Run a pool's nodes on Fly.io: a pool on the control plane, and a private
 * Fly Service whose Machines host every `Rivet.DurableObject` given this
 * pool. Nodes only connect out to the control plane, so the Service takes
 * no traffic and works with any control plane it can reach —
 * `RivetFly.MachineControlPlane`, `RivetCloud.ControlPlane`, or one on another
 * cloud.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Fly
 * **Example:** Two nodes
 * ```typescript
 * export const Cluster = RivetFly.MachineControlPlane("Rivet");
 * export const Default = RivetFly.MachinePool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const MachinePool = (id: string, options: MachinePoolOptions = {}) =>
  makePoolLayer({
    label: "RivetFly.MachinePool",
    id,
    settings: options,
    expected: "a reachable control plane",
    // Fly Machines reach the internet without a network of their own.
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    // Every class the pool hosts is bundled into the node program;
    // RivetKit is installed beside it (it loads a native addon).
    nodes: Effect.fn(function* (nodes) {
      yield* Fly.Service(`${id}Nodes`, {
        // A Rust program is its own image, built from its staged crate.
        ...(isImageProgram(nodes.program)
          ? { context: nodes.program.context }
          : {
              main: (yield* bundleNodes("fly", id, nodes.program)) as unknown as string,
              build: { install: { rivetkit: RIVETKIT_VERSION } },
            }),
        public: false,
        // Nodes only dial out: nothing listens for the proxy to check.
        services: [],
        region: options.region ?? "iad",
        count: options.replicas ?? 1,
        guest: options.guest ?? { cpus: 1, memoryMb: 1024 },
        env: nodeEnvironment(nodes),
      });
    }),
  });
