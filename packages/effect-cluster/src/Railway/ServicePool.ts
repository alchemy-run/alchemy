import * as Railway from "@alchemy.run/railway";
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

export interface ServicePoolOptions extends PoolSettings {
  /**
   * Region of the runner.
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

/**
 * The private hostname Railway gives a Service named `name`: the name with
 * each run of hyphens made one, so a Service named `a--b` is reached at
 * `a-b.railway.internal`.
 */
const privateHostname = (name: string) => name.replace(/-{2,}/g, "-");

/**
 * Run a pool of Effect Cluster runners on Railway: one Railway Service in
 * the database's project and environment, built from the bundled runner
 * program. The runner registers under the Service's private hostname on
 * the project's private network, where callers in the same environment
 * reach its gateway too: the gateway has no public domain. With a database in no
 * Railway project (`Cluster.Database.fromUrl`), give the pool its `project`.
 *
 * Railway gives every replica of a Service the same private hostname, so the
 * pool runs one runner. For more runners, declare more pools.
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
    nodes: ({ network, name, program, environment }) =>
      Railway.Service(`${id}Pool`, {
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
        env: environment.pipe(
          Output.map((env) => ({
            ...env,
            // Railway's private network is IPv6: listen on every address,
            // and register under the hostname the other runners resolve.
            CLUSTER_LISTEN_HOST: "::",
            CLUSTER_RUNNER_HOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
          })),
        ),
      }).pipe(Effect.asVoid),
  });
