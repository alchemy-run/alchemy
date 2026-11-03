import * as Docker from "@alchemy.run/docker";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import type { Providers } from "../Providers.ts";

/** The Postgres release `ClusterDocker.Database` runs by default. */
export const DEFAULT_POSTGRES_IMAGE = "postgres:17-alpine";

export interface DatabaseProps {
  /**
   * Postgres image.
   * @default "postgres:17-alpine"
   */
  image?: string;
  /**
   * Publish Postgres on this host port, to inspect it from your machine.
   * @default not published
   */
  port?: number;
  /**
   * The Docker engine to run on: a context name, a `Docker.Context`, or a
   * `Docker.Swarm`.
   * @default the current Docker context
   */
  context?: Docker.Docker.EngineRef;
}

/**
 * The database an Effect Cluster coordinates through, on a Docker swarm, as
 * an `Cluster.Database` Layer: Postgres as a one-replica swarm service
 * with its data on a named volume, on an overlay network the pool's runners join.
 * The Docker engine must be in swarm mode (`docker swarm init`).
 *
 * One Postgres on one disk is meant for development and tests.
 *
 * ### Running a local database
 * **Example:** Postgres for local entities
 * ```typescript
 * export const Database = ClusterDocker.Database("Cluster");
 * ```
 *
 * @primitive
 */
export const Database = (
  id: string,
  props: DatabaseProps = {},
): Layer.Layer<ClusterDatabase, never, Providers | Docker.Providers> =>
  Layer.effect(
    ClusterDatabase,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      const context = props.context === undefined ? {} : { context: props.context };
      const password = yield* Random(`${id}Password`, { bytes: 24 }) as unknown as Effect.Effect<
        Random,
        never,
        Providers
      >;
      const network = yield* Docker.Network(`${id}Network`, { driver: "overlay", ...context });
      const volumeContext = Docker.dockerEngineContextName(props.context);
      const data = yield* Docker.Volume(
        `${id}Data`,
        volumeContext === undefined ? {} : { context: volumeContext },
      );
      const alias = "cluster-db";
      const db = yield* Docker.Service(`${id}Postgres`, {
        image: props.image ?? DEFAULT_POSTGRES_IMAGE,
        ...context,
        environment: { POSTGRES_PASSWORD: password.text, POSTGRES_DB: "cluster" },
        ports: props.port === undefined ? [] : [{ external: props.port, internal: 5432 }],
        volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql/data" }],
        networks: [{ name: network.name, aliases: [alias] }],
        replicas: 1,
      });
      return {
        // Ordered after the service: runners connect once it exists.
        url: Output.all(db.name, password.text).pipe(
          Output.map(([, text]) =>
            Redacted.make(
              `postgres://postgres:${encodeURIComponent(text.pipe(Redacted.value))}@${alias}:5432/cluster`,
            ),
          ),
        ),
        network: { kind: "docker" as const, name: network.name },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
