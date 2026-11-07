import * as Hetzner from "@alchemy.run/hetzner";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";

export interface ServerPoolOptions extends PoolSettings {
  /**
   * Number of runners, one Server each.
   * @default 2
   */
  replicas?: number;
  /**
   * Server type of each runner.
   * @default "cx23"
   */
  serverType?: string;
}

/** The label the gateway's Load Balancer finds the pool's Servers by. */
const POOL_LABEL = "cluster-pool";

/**
 * Run a pool of Effect Cluster runners on Hetzner Cloud: Servers on the
 * database's private Network, each running every class given these
 * runners as a `Hetzner.Service`, behind a Load Balancer that serves their
 * gateway to callers anywhere. Runners talk to each other and the database
 * over the Network; their firewall only lets SSH in, which deploys them.
 * Requires a database on a Hetzner Network — `ClusterHetzner.Database`.
 *
 * ### Running on Hetzner
 * **Example:** Two runners
 * ```typescript
 * export const Database = ClusterHetzner.Database("Cluster");
 * export const Default = ClusterHetzner.ServerPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * @primitive
 */
export const ServerPool = (id: string, options: ServerPoolOptions = {}) =>
  makePoolLayer({
    label: "ClusterHetzner.ServerPool",
    id,
    settings: options,
    expected: "a Hetzner Network (ClusterHetzner.Database)",
    network: (database) => (database.network?.kind === "hetzner" ? database.network : undefined),
    // The Load Balancer finds the Servers by label, so it needs none of them.
    gateway: (name, network) =>
      Effect.gen(function* () {
        const balancer = yield* Hetzner.LoadBalancer(`${id}Gateway`, {
          loadBalancerType: "lb11",
          location: network.location,
          // A stub of the database's Network, by id.
          networks: [{ networkId: network.networkId } as unknown as Hetzner.Network],
          services: [
            {
              protocol: "tcp",
              listenPort: 80,
              destinationPort: GATEWAY_PORT,
              healthCheck: {
                protocol: "http",
                port: GATEWAY_PORT,
                interval: 10,
                timeout: 5,
                retries: 3,
                http: { path: "/health" },
              },
            },
          ],
          targets: [
            { type: "label_selector", selector: `${POOL_LABEL}=${name}`, usePrivateIp: true },
          ],
        });
        return { url: Output.interpolate`http://${balancer.ipv4}` };
      }),
    nodes: ({ network, name, program, environment }) =>
      Effect.gen(function* () {
        const firewall = yield* Hetzner.Firewall(`${id}Firewall`, {
          rules: [
            {
              description: "SSH, which deploys the pool",
              direction: "in",
              protocol: "tcp",
              port: "22",
              sourceIps: ["0.0.0.0/0", "::/0"],
            },
          ],
        });
        for (let i = 0; i < (options.replicas ?? 2); i++) {
          const server = yield* Hetzner.Server(`${id}Runner${i}`, {
            serverType: options.serverType ?? "cx23",
            image: "ubuntu-24.04",
            location: network.location,
            // IPv4 installs Node and deploys over SSH; IPv6 would only spend an address.
            enableIpv6: false,
            networks: [{ networkId: network.networkId as number }],
            firewalls: [firewall],
            labels: { [POOL_LABEL]: name },
          });
          yield* Hetzner.Service(`${id}Runner${i}Service`, {
            server,
            main: program.pipe(Output.map((p) => `${p.dir}/runner.mjs`)) as unknown as string,
            port: GATEWAY_PORT,
            env: environment.pipe(
              // Each runner finds its own address in the Network's range.
              Output.map((env) => ({
                ...env,
                CLUSTER_RUNNER_NETWORK: network.ipRange,
              })),
            ) as unknown as Record<string, string>,
          });
        }
      }),
  });
