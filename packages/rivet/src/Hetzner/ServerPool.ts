import * as Hetzner from "@alchemy.run/hetzner";
import * as Effect from "effect/Effect";
import {
  bundleNodes,
  isImageProgram,
  makePoolLayer,
  nodeEnvironment,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";

export interface ServerPoolOptions extends PoolSettings {
  /**
   * Number of nodes, one Server each.
   * @default 1
   */
  replicas?: number;
  /**
   * Hetzner location of the Servers.
   * @default "nbg1"
   */
  location?: string;
  /**
   * Server type of each node.
   * @default "cx23"
   */
  serverType?: string;
}

/**
 * Run a pool's nodes on Hetzner Cloud: a pool on the control plane, and
 * Servers that each run every `Rivet.DurableObject` given this pool as a
 * `Hetzner.Service`. Nodes only connect out to the control plane, so a
 * firewall drops every inbound connection except SSH, which deploys them;
 * the pool works with any control plane it can reach —
 * `RivetHetzner.ServerControlPlane`, `RivetCloud.ControlPlane`, or one on another
 * cloud.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Hetzner
 * **Example:** Two nodes
 * ```typescript
 * export const Cluster = RivetHetzner.ServerControlPlane("Rivet");
 * export const Default = RivetHetzner.ServerPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const ServerPool = (id: string, options: ServerPoolOptions = {}) =>
  makePoolLayer({
    label: "RivetHetzner.ServerPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    // Servers reach the control plane's public address.
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    // Every class the pool hosts is bundled into the node program;
    // RivetKit is installed beside it (it loads a native addon).
    nodes: Effect.fn(function* (nodes) {
      // A Rust program is its own image, run in Docker on each Server.
      const program = isImageProgram(nodes.program)
        ? { context: nodes.program.context, dockerfile: nodes.program.dockerfile }
        : {
            main: (yield* bundleNodes("hetzner", id, nodes.program)) as unknown as string,
            build: { install: { rivetkit: RIVETKIT_VERSION } },
          };
      const location = options.location ?? "nbg1";
      const firewall = yield* Hetzner.Firewall(`${id}Firewall`, {
        rules: [
          {
            description: "SSH, which deploys the nodes",
            direction: "in",
            protocol: "tcp",
            port: "22",
            sourceIps: ["0.0.0.0/0", "::/0"],
          },
        ],
      });
      const env = nodeEnvironment(nodes);
      for (let i = 0; i < (options.replicas ?? 1); i++) {
        const server = yield* Hetzner.Server(`${id}Node${i}`, {
          serverType: options.serverType ?? "cx23",
          image: "ubuntu-24.04",
          location,
          firewalls: [firewall],
          // Nodes only dial out to the control plane's IPv4 address: an
          // IPv6 address would only use up the project's primary IPs.
          enableIpv6: false,
        });
        yield* Hetzner.Service(`${id}Node${i}Service`, {
          server,
          ...program,
          env,
        });
      }
    }),
  });
