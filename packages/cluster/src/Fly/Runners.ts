import * as Fly from "@alchemy.run/fly";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makeRunnersLayer, type RunnersSettings } from "../internal/RunnersHost.ts";

export interface RunnersOptions extends RunnersSettings {
  /**
   * Number of runners.
   * @default 2
   */
  replicas?: number;
  /**
   * Fly region of the runners.
   * @default "iad"
   */
  region?: string;
  /**
   * Machine size of each runner.
   * @default { cpus: 1, memoryMb: 1024 }
   */
  guest?: Fly.MachineGuest;
}

/**
 * Run an Effect Cluster's runners on Fly.io: a Fly Service whose Machines
 * host every class given these runners, on the database's private
 * network. Runners talk to each other and the database over the network;
 * the Service serves their gateway at `https://{name}.fly.dev` to callers
 * anywhere. Requires a database on a Fly network — `ClusterFly.Database`.
 *
 * ### Running on Fly
 * **Example:** Two runners in Ashburn
 * ```typescript
 * export const Database = ClusterFly.Database("Cluster");
 * export const Default = ClusterFly.Runners("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * @primitive
 */
export const Runners = (id: string, options: RunnersOptions = {}) =>
  makeRunnersLayer({
    label: "ClusterFly.Runners",
    id,
    settings: options,
    expected: "a Fly private network (ClusterFly.Database)",
    // Fly App names are at most 30 characters.
    nameLength: 30,
    network: (database) => (database.network?.kind === "fly" ? database.network : undefined),
    // The Service's App is named after the runners.
    gateway: (name) => Effect.succeed({ url: `https://${name}.fly.dev` }),
    nodes: ({ network, name, program, environment }) =>
      Fly.Service(`${id}Runners`, {
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
