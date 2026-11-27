import * as Docker from "@alchemy.run/docker";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Database } from "../Database.ts";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";
import type { PoolHost } from "../internal/PoolHostService.ts";
import type { Providers } from "../Providers.ts";

export interface SwarmPoolOptions extends PoolSettings {
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
  /**
   * The overlay network runners join when the database is on no Docker
   * network, such as `Cluster.Database.fromUrl`: a `Docker.Network`, or `{ name }`
   * of one. Ignored when the database is on one.
   * @default an overlay network of the pool's own
   */
  network?: { name: Input<string> } | Effect.Effect<{ name: Input<string> }, never, any>;
  /**
   * The Docker engine to build the runner image and run the runners on: a
   * context name, a `Docker.Context`, or a `Docker.Swarm`.
   * @default the current Docker context
   */
  context?: Docker.Docker.EngineRef;
  /**
   * The runner image's Dockerfile, for runners that need more than Node,
   * such as a private certificate authority the database's TLS certificate
   * is signed by. It must copy `*.mjs` into `/app` and run `/app/runner.mjs`.
   * @default the default runner Dockerfile
   */
  dockerfile?: string;
}

/**
 * Run a pool of Effect Cluster runners on a Docker swarm: a swarm service whose
 * tasks host every `Cluster.Entity` given this pool, on the
 * database's overlay network. Runners find each other through the
 * database and talk on the network; the gateway is served on the same
 * network. With a database on no Docker network (`Cluster.Database.fromUrl`),
 * runners join the pool's `network`, or an overlay network of its own.
 *
 * Every entity given the same pool shares it: declare the pool once
 * and provide them to each class.
 *
 * ### Running entities on Docker
 * **Example:** Two runners on the local swarm
 * ```typescript
 * export const Database = ClusterDocker.Database("Cluster");
 * export const Default = ClusterDocker.SwarmPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * ### Using a database you already run
 * **Example:** Runners on their own network, connecting to Postgres by URL
 * ```typescript
 * export const Database = Cluster.Database.fromUrl({
 *   url: Config.Redacted("CLUSTER_DATABASE_URL"),
 * });
 * export const Default = ClusterDocker.SwarmPool("Default").pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * **Example:** Runners on a remote engine, trusting a private CA
 * ```typescript
 * export const Default = ClusterDocker.SwarmPool("Default", {
 *   // A Docker context on this machine, e.g. `docker context create vps --docker host=ssh://deploy@vps`.
 *   context: "vps",
 *   dockerfile: [
 *     "FROM node:26-slim",
 *     "WORKDIR /app",
 *     "COPY *.mjs /app/",
 *     "ADD https://pki.example.com/root-ca.pem /etc/ssl/db-ca.pem",
 *     "ENV NODE_EXTRA_CA_CERTS=/etc/ssl/db-ca.pem NODE_ENV=production",
 *     'ENTRYPOINT ["node", "/app/runner.mjs"]',
 *   ].join("\n"),
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const SwarmPool = (
  id: string,
  options: SwarmPoolOptions = {},
): Layer.Layer<PoolHost, never, Database | Stack | Providers | Docker.Providers> => {
  const context = options.context === undefined ? {} : { context: options.context };
  const imageContext = Docker.dockerEngineContextName(options.context);
  return makePoolLayer({
    label: "ClusterDocker.SwarmPool",
    id,
    settings: options,
    expected: "a Docker network (ClusterDocker.Database)",
    network: (database) => (database.network?.kind === "docker" ? database.network : undefined),
    ownNetwork:
      options.network === undefined
        ? Docker.Network(`${id}Network`, { driver: "overlay", ...context }).pipe(
            Effect.map((network) => ({ kind: "docker" as const, name: network.name })),
          )
        : Effect.map(
            Effect.isEffect(options.network) ? options.network : Effect.succeed(options.network),
            (network) => ({ kind: "docker" as const, name: network.name }),
          ),
    ...(options.dockerfile === undefined ? {} : { dockerfile: options.dockerfile }),
    // Callers on the swarm reach the gateway by the service's name.
    gateway: (name) => Effect.succeed({ url: `http://${name}:${GATEWAY_PORT}` }),
    nodes: ({ network, name, program, environment }) =>
      Effect.gen(function* () {
        // Tagged with the program's hash, so a changed program is a new image.
        const image = yield* Docker.Image(`${id}RunnerImage`, {
          build: { context: program.pipe(Output.map((p) => p.dir)) as unknown as string },
          tag: program.pipe(Output.map((p) => p.hash)) as unknown as string,
          skipPush: true,
          ...(imageContext === undefined ? {} : { context: imageContext }),
        });
        yield* Docker.Service(`${id}Pool`, {
          name,
          image: image.imageRef,
          replicas: options.replicas ?? 1,
          ...context,
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
};
