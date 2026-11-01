import * as Fly from "@alchemy.run/fly";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makePoolLayer,
  nodeEnvironment,
  RIVETKIT_VERSION,
  stackDnsLabel,
  type PoolNodes,
  type PoolSettings,
} from "../internal/PoolHost.ts";

export interface PoolOptions extends PoolSettings {
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
 * `RivetFly.ControlPlane`, `RivetCloud.ControlPlane`, or one on another
 * cloud.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Fly
 * **Example:** Two nodes
 * ```typescript
 * export const Cluster = RivetFly.ControlPlane("Rivet");
 * export const Default = RivetFly.Pool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const Pool = (id: string, options: PoolOptions = {}) =>
  makePoolLayer({
    label: "RivetFly.Pool",
    id,
    settings: options,
    expected: "a reachable control plane",
    // Fly Machines reach the internet without a network of their own.
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    // Every class the pool hosts is bundled into the node program;
    // RivetKit is installed beside it (it loads a native addon).
    nodes: Effect.fn(function* (nodes) {
      const main = yield* bundleNodes(id, nodes);
      yield* Fly.Service(`${id}Nodes`, {
        main: main as unknown as string,
        build: { install: { rivetkit: RIVETKIT_VERSION } },
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

/**
 * Bundle the node program into a directory of its own, once the pool knows
 * its classes. A Fly Service without an Effect implementation runs its
 * `main` as it is, so it is handed the built entry.
 */
const bundleNodes = Effect.fn(function* (id: string, nodes: PoolNodes<unknown>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(yield* dotAlchemyDirectory, "rivet", "fly", yield* stackDnsLabel(id));
  const { external, plugins } = nodes.program.build.input;
  return Output.mapEffect((resolved: Parameters<typeof Bundle.build>[0]["plugins"]) =>
    Effect.gen(function* () {
      yield* fs.remove(dir, { recursive: true, force: true });
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* Bundle.build(
        {
          input: nodes.program.main,
          platform: "node",
          external,
          resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
          plugins: resolved,
        },
        { dir, format: "esm", entryFileNames: "node.mjs", codeSplitting: false },
      );
      return path.join(dir, "node.mjs");
    }).pipe(Effect.orDie),
  )(plugins);
});
