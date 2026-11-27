import * as Railway from "@alchemy.run/railway";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import type { Providers } from "../Providers.ts";

export interface DatabaseProps {
  /** The Railway project the database and runners run in. */
  project: Input<Railway.PostgresProps["project"]>;
  /**
   * The Railway environment the database and runners run in.
   * @default the project's primary environment
   */
  environment?: Input<Railway.PostgresProps["environment"]>;
  /**
   * The Postgres service's name, which is also its private hostname.
   * @default generated from the stack, stage and id
   */
  name?: string;
  /**
   * Postgres image.
   * @default "ghcr.io/railwayapp-templates/postgres-ssl:16"
   */
  image?: string;
  /**
   * Keep the database when its declaration is removed or the stage is
   * destroyed. Its project and environment keep their own policy, and
   * deleting either deletes the database with it.
   * @default the enclosing removal policy
   */
  retain?: boolean;
}

/**
 * The database an Effect Cluster coordinates through, on Railway, as a
 * `Cluster.Database` Layer: a Railway Postgres in the project's environment,
 * reached over the project's private network at `{name}.railway.internal`.
 * It has no public endpoint.
 *
 * ### Running the database on Railway
 * **Example:** Postgres in a project
 * ```typescript
 * export const Project = Railway.Project("App");
 *
 * export const Database = ClusterRailway.Database("Cluster", { project: Project });
 * ```
 *
 * **Example:** A retained database in another environment
 * ```typescript
 * export const Staging = Railway.Environment("Staging", { project: Project });
 *
 * export const Database = ClusterRailway.Database("Cluster", {
 *   project: Project,
 *   environment: Staging,
 *   name: "cluster-db",
 *   retain: true,
 * });
 * ```
 *
 * @primitive
 */
export const Database = (
  id: string,
  props: DatabaseProps,
): Layer.Layer<ClusterDatabase, never, Providers | Railway.Providers> =>
  Layer.effect(
    ClusterDatabase,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      // Resolved before `retain` applies, which would otherwise also decorate
      // a project or environment the database is first to declare. As in
      // Railway.Postgres, an Effect-valued parent needs only Railway's providers.
      const project = Effect.isEffect(props.project)
        ? yield* props.project as Effect.Effect<Railway.Project, never, Railway.Providers>
        : props.project;
      const environment = Effect.isEffect(props.environment)
        ? yield* props.environment as Effect.Effect<
            Railway.PostgresEnvironment,
            never,
            Railway.Providers
          >
        : props.environment;
      const postgres = Railway.Postgres(id, {
        project,
        ...(environment === undefined ? {} : { environment }),
        ...(props.name === undefined ? {} : { name: props.name }),
        // No `region`: Railway reports none for the instance, so declaring
        // one would plan a replacement on every deploy.
        ...(props.image === undefined ? {} : { image: props.image }),
        database: "cluster",
        public: false,
      });
      const { name } = yield* props.retain === undefined
        ? postgres
        : postgres.pipe(retain(props.retain));
      return {
        // A Railway variable reference, resolved into each runner's
        // environment: the database's own private URL, which survives a
        // rename of its service and links the two on the canvas.
        url: name.pipe(
          Output.map((name) => Redacted.make(Railway.ref(name, Railway.DATABASE_URL_SECRET))),
        ),
        network: { kind: "railway" as const, project, environment },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
