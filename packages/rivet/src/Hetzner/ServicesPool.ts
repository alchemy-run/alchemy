import * as Hetzner from "@alchemy.run/hetzner";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { stackDnsLabel } from "../internal/PoolHost.ts";
import {
  makeServicesLayer,
  secretServicesEnvironment,
  type ServicesPoolSettings,
} from "../internal/ServicesHost.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * Number of Services nodes, one Server each.
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
 * A build context whose image is Rivet's Services image as it is: the
 * Service runs it with its env, which reaches the Server over SSH.
 */
const stageServicesImage = Effect.fn(function* (id: string, image: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(
    yield* dotAlchemyDirectory,
    "rivet",
    "hetzner-services",
    yield* stackDnsLabel(id),
  );
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, "Dockerfile"), `FROM ${image}\n`);
  return dir;
});

/**
 * Run Rivet Services on Hetzner Cloud: the `services` pool on the control
 * plane, and Servers running Rivet's prebuilt Services node on Docker, which
 * hosts Durable Streams and agentOS. A firewall drops every inbound
 * connection except SSH, which deploys the nodes: callers reach every
 * stream through the control plane's gateway, with its token. Works with
 * any control plane it can reach.
 *
 * Hetzner Cloud has no secret store and no instance identity a node could
 * read one with, so the control plane's token is copied over SSH into an
 * env file on each Server that only root can read. It never goes into the
 * Server's user data, which any process on it can read from the metadata
 * service. Root on the Server can still read it.
 *
 * ### Running Rivet Services on Hetzner
 * **Example:** Services next to a Hetzner control plane
 * ```typescript
 * export const Cluster = RivetHetzner.ServerControlPlane("Rivet");
 * export const Services = RivetHetzner.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (id: string, options: ServicesPoolOptions = {}) =>
  makeServicesLayer({
    label: "RivetHetzner.ServicesPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    nodes: Effect.fn(function* (nodes) {
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
      const context = yield* stageServicesImage(id, nodes.image).pipe(Effect.orDie);
      const env = secretServicesEnvironment(nodes);
      for (let i = 0; i < (options.replicas ?? 1); i++) {
        const server = yield* Hetzner.Server(`${id}Node${i}`, {
          serverType: options.serverType ?? "cx23",
          // Services nodes only dial out, over IPv4.
          enableIpv6: false,
          image: "docker-ce",
          location: options.location ?? "nbg1",
          firewalls: [firewall],
        });
        yield* Hetzner.Service(`${id}Node${i}Service`, { server, context, env });
      }
    }),
  });
