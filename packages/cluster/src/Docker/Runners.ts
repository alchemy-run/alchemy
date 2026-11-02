import * as Docker from "@alchemy.run/docker";
import * as Output from "alchemy/Output";
import type { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Database } from "../Database.ts";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makeRunnersLayer, type RunnersSettings } from "../internal/RunnersHost.ts";
import type { RunnersHost } from "../internal/RunnersHostService.ts";
import type { Providers } from "../Providers.ts";

export interface RunnersOptions extends RunnersSettings {
  /**
   * Number of runners.
   * @default 1
   */
  replicas?: number;
  /**
   * Publish the gateway on this host port, so code outside the swarm (a
   * test, a script) can call the entities at `http://localhost:<port>`.
   * @default not published
   */
  gatewayPort?: number;
}

/**
 * Run an Effect Cluster's runners on a Docker swarm: a swarm service whose
 * tasks host every `Cluster.Entity` given these runners, on the
 * database's overlay network. Runners find each other through the
 * database and talk on the network; the gateway is served on the same
 * network. Requires an `Cluster.Database` on a Docker network —
 * `ClusterDocker.Database`.
 *
 * Every entity given the same runners shares them: declare the runners once
 * and provide them to each class.
 *
 * ### Running entities on Docker
 * **Example:** Two runners on the local swarm
 * ```typescript
 * export const Database = ClusterDocker.Database("Cluster");
 * export const Default = ClusterDocker.Runners("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * @primitive
 */
export const Runners = (
  id: string,
  options: RunnersOptions = {},
): Layer.Layer<RunnersHost, never, Database | Stack | Providers | Docker.Providers> =>
  makeRunnersLayer({
    label: "ClusterDocker.Runners",
    id,
    settings: options,
    expected: "a Docker network (ClusterDocker.Database)",
    network: (database) => (database.network?.kind === "docker" ? database.network : undefined),
    // Callers on the swarm reach the gateway by the service's name.
    gateway: (name) => Effect.succeed({ url: `http://${name}:${GATEWAY_PORT}` }),
    nodes: ({ network, name, program, environment }) =>
      Effect.gen(function* () {
        // Tagged with the program's hash, so a changed program is a new image.
        const image = yield* Docker.Image(`${id}RunnerImage`, {
          build: { context: program.pipe(Output.map((p) => p.dir)) as unknown as string },
          tag: program.pipe(Output.map((p) => p.hash)) as unknown as string,
          skipPush: true,
        });
        yield* Docker.Service(`${id}Runners`, {
          name,
          image: image.imageRef,
          replicas: options.replicas ?? 1,
          networks: [{ name: network.name }],
          ports:
            options.gatewayPort === undefined
              ? []
              : [{ external: options.gatewayPort, internal: GATEWAY_PORT }],
          // Each runner finds its own address among the service's tasks.
          environment: environment.pipe(
            Output.map((env) => ({ ...env, CLUSTER_PEERS: `tasks.${name}` })),
          ) as unknown as Record<string, string>,
        });
      }),
  });
