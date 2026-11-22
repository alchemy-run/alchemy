import * as Fly from "@alchemy.run/fly";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";

export interface MachinePoolOptions extends PoolSettings {
  /**
   * Number of runners.
   * @default 2
   */
  replicas?: number;
  /**
   * Fly region of the pool.
   * @default "iad"
   */
  region?: string;
  /**
   * Machine size of each runner.
   * @default { cpus: 1, memoryMb: 1024 }
   */
  guest?: Fly.MachineGuest;
  /**
   * The Fly private network runners join when the database is on none,
   * such as `Cluster.Database.fromUrl`. Ignored when the database is on one.
   * @default a network for the stack and stage
   */
  network?: string;
}

/**
 * Run a pool of Effect Cluster runners on Fly.io: a Fly Service whose Machines
 * host every class given this pool, on the database's private
 * network. Runners talk to each other and the database over the network;
 * the Service serves their gateway at `https://{name}.fly.dev` to callers
 * anywhere. With a database on no Fly network (`Cluster.Database.fromUrl`),
 * runners join the pool's `network`, or one for the stack and stage.
 *
 * ### Running on Fly
 * **Example:** Two runners in Ashburn
 * ```typescript
 * export const Database = ClusterFly.Database("Cluster");
 * export const Default = ClusterFly.MachinePool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * @primitive
 */
export const MachinePool = (id: string, options: MachinePoolOptions = {}) =>
  makePoolLayer({
    label: "ClusterFly.MachinePool",
    id,
    settings: options,
    expected: "a Fly private network (ClusterFly.Database)",
    // Fly App names are at most 30 characters.
    nameLength: 30,
    network: (database) => (database.network?.kind === "fly" ? database.network : undefined),
    ownNetwork: Effect.map(
      options.network === undefined ? Fly.stackNetwork : Effect.succeed(options.network),
      (network) => ({ kind: "fly" as const, network }),
    ),
    // The Service's App is named after the pool.
    gateway: (name) => Effect.succeed({ url: `https://${name}.fly.dev` }),
    nodes: ({ network, name, program, environment }) =>
      Fly.Service(`${id}Pool`, {
        name,
        network: network.network as string,
        main: program.pipe(Output.map((p) => `${p.dir}/runner.mjs`)) as unknown as string,
        region: options.region ?? "iad",
        count: options.replicas ?? 2,
        guest: options.guest ?? { cpus: 1, memoryMb: 1024 },
        port: GATEWAY_PORT,
        public: true,
        env: environment.pipe(
          // Runners listen on the private network, which is IPv6.
          Output.map((env) => ({
            ...env,
            CLUSTER_LISTEN_HOST: "::",
          })),
        ) as unknown as Record<string, string>,
      }).pipe(Effect.asVoid),
  });
