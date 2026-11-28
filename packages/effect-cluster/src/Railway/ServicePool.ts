import * as Railway from "@alchemy.run/railway";
import { isReplicaCount } from "@alchemy.run/railway/ServiceRegion";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Database } from "../Database.ts";
import { GATEWAY_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";
import type { PoolHost } from "../internal/PoolHostService.ts";
import type { Providers } from "../Providers.ts";

/** How long Railway lets a stopping runner run before it kills it. */
const RUNNER_DRAINING_SECONDS = 30;

export interface ServicePoolOptions extends PoolSettings {
  /**
   * Number of runners: replicas of the pool's one Railway Service, all in
   * its shard group, a whole number of at least 1. More than one needs the
   * database on the project's private network (`ClusterRailway.Database`).
   * Changing it updates the same Service in place; Railway replaces every
   * replica in the deployment that applies it.
   * @default 1
   */
  replicas?: number;
  /**
   * Region of the runners.
   * @default the workspace's default region
   */
  region?: string;
  /**
   * The Railway project the runner runs in when the database is in none,
   * such as `Cluster.Database.fromUrl`. Ignored when the database is in one.
   */
  project?: Input<Railway.ServiceProps["project"]>;
  /**
   * The environment of `project` the runner runs in.
   * @default the project's primary environment
   */
  environment?: Input<Railway.ServiceProps["environment"]>;
}

/** `ClusterRailway.ServicePool` options that can't run. */
export class InvalidServicePoolOptions extends Data.TaggedError(
  "ClusterRailway.InvalidServicePoolOptions",
)<{
  readonly message: string;
}> {}

/**
 * The private hostname Railway gives a Service named `name`: the name with
 * each run of hyphens made one, so a Service named `a--b` is reached at
 * `a-b.railway.internal`.
 */
const privateHostname = (name: string) => name.replace(/-{2,}/g, "-");

/**
 * Run a pool of Effect Cluster runners on Railway: one Railway Service in
 * the database's project and environment, built from the bundled runner
 * program, with as many runners as it has `replicas`, all in the pool's
 * shard group. Callers in the same environment reach the pool's gateway at
 * the Service's private hostname, which lists every replica: the gateway has
 * no public domain. With a database in no Railway project
 * (`Cluster.Database.fromUrl`), give the pool its `project`.
 *
 * Beside a `ClusterRailway.Database`, each runner registers under its own
 * private address, the one it reaches the database from, so replicas, and a
 * deployment overlapping the one it replaces, never share one. Railway
 * stops a runner with SIGTERM on every deploy, restart and scale, and the
 * runner hands its shards back and unregisters before it exits, so the
 * other runners take them at once. With a database elsewhere, the pool runs
 * one runner under the Service's hostname.
 *
 * ### Running on Railway
 * **Example:** A pool beside its database
 * ```typescript
 * export const Project = Railway.Project("App");
 *
 * export const Database = ClusterRailway.Database("Cluster", { project: Project });
 *
 * export const Default = ClusterRailway.ServicePool("Default").pipe(Layer.provide(Database));
 * ```
 *
 * **Example:** Three runners in one shard group
 * ```typescript
 * export const Default = ClusterRailway.ServicePool("Default", { replicas: 3 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * **Example:** A pool on a database you already run
 * ```typescript
 * export const Database = Cluster.Database.fromUrl({
 *   url: Config.Redacted("CLUSTER_DATABASE_URL"),
 * });
 *
 * export const Default = ClusterRailway.ServicePool("Default", {
 *   project: Project,
 *   region: "us-west2",
 * }).pipe(Layer.provide(Database));
 * ```
 *
 * @primitive
 */
export const ServicePool = (
  id: string,
  options: ServicePoolOptions = {},
): Layer.Layer<PoolHost, never, Database | Stack | Providers | Railway.Providers> =>
  makePoolLayer({
    label: "ClusterRailway.ServicePool",
    id,
    settings: options,
    expected: "a Railway project (ClusterRailway.Database)",
    networkOption: "project",
    // Railway refuses a Service name longer than 32 characters.
    nameLength: 32,
    network: (database) => (database.network?.kind === "railway" ? database.network : undefined),
    ownNetwork: Effect.succeed(
      options.project === undefined
        ? undefined
        : { kind: "railway" as const, project: options.project, environment: options.environment },
    ),
    // Callers deploy before the runner exists, when a Railway reference to
    // it would render empty. The Service is created with this name, and
    // Railway derives its private hostname from it.
    gateway: (name) =>
      Effect.succeed({ url: `http://${privateHostname(name)}.railway.internal:${GATEWAY_PORT}` }),
    nodes: ({ database, network, name, program, environment }) => {
      const replicas = options.replicas ?? 1;
      // On the project's private network each runner has an address of its
      // own: the one it reaches the database from. With a database
      // elsewhere it has only the Service's hostname, which every replica
      // and an overlapping deployment's runner share.
      const ownAddress = database.network?.kind === "railway";
      if (!isReplicaCount(replicas)) {
        return Effect.die(
          new InvalidServicePoolOptions({
            message: `ClusterRailway.ServicePool "${id}": replicas must be a whole number of at least 1, not ${replicas}.`,
          }),
        );
      }
      if (replicas > 1 && !ownAddress) {
        return Effect.die(
          new InvalidServicePoolOptions({
            message: `ClusterRailway.ServicePool "${id}": more than one replica needs the database on the project's private network (ClusterRailway.Database).`,
          }),
        );
      }
      return Railway.Service(`${id}Pool`, {
        project: network.project as Input<Railway.ServiceProps["project"]>,
        ...(network.environment === undefined
          ? {}
          : { environment: network.environment as Input<Railway.ServiceProps["environment"]> }),
        name,
        // The bundled runner and its Dockerfile, uploaded as the build context.
        context: program.pipe(Output.map((p) => p.dir)),
        port: GATEWAY_PORT,
        healthcheck: "/health",
        publicDomain: false,
        ...(options.region === undefined ? {} : { region: options.region }),
        replicas,
        ...(ownAddress ? { drainingSeconds: RUNNER_DRAINING_SECONDS } : {}),
        env: environment.pipe(
          Output.map((env) => ({
            ...env,
            // Railway's private network is IPv6: listen on every address.
            CLUSTER_LISTEN_HOST: "::",
            // Railway keeps a variable a deploy no longer sets, so both
            // branches set all three; an empty one is unset.
            ...(ownAddress
              ? {
                  CLUSTER_RUNNER_ROUTE: "database",
                  CLUSTER_RUNNER_HOST: "",
                  // Stop within Railway's draining window, keeping 5 seconds
                  // for the process to exit.
                  CLUSTER_SHUTDOWN_TIMEOUT_MS: String((RUNNER_DRAINING_SECONDS - 5) * 1000),
                }
              : {
                  CLUSTER_RUNNER_ROUTE: "",
                  // The one runner registers under the hostname the others resolve.
                  CLUSTER_RUNNER_HOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
                  CLUSTER_SHUTDOWN_TIMEOUT_MS: "",
                }),
          })),
        ),
      }).pipe(Effect.asVoid);
    },
  });
