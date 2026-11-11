import * as Fly from "@alchemy.run/fly";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import type { Providers } from "../Providers.ts";

export interface DatabaseProps {
  /**
   * Fly region of the database.
   * @default "iad"
   */
  region?: string;
  /**
   * Postgres image.
   * @default "postgres:17-alpine"
   */
  image?: string;
  /**
   * Size of the database's volume, in GB.
   * @default 10
   */
  diskSize?: number;
  /**
   * Machine size of the database.
   * @default { cpus: 1, memoryMb: 1024 }
   */
  guest?: Fly.MachineGuest;
  /**
   * The Fly private network the database and runners join.
   * @default a network for the stack and stage
   */
  network?: string;
}

/** Where Postgres keeps its data, below the volume's mount point. */
const DATA = "/var/lib/postgresql/data";

/**
 * The database an Effect Cluster coordinates through, on Fly.io, as a
 * `Cluster.Database` Layer: Postgres on a Fly Machine with a volume, in an
 * App on a private network that the pool's runners join. Nothing outside the
 * network reaches it.
 *
 * One Postgres on one volume is meant for development and small clusters;
 * for Fly's Managed Postgres, pass its URL to `Cluster.Database.fromUrl`.
 *
 * ### Running the database on Fly
 * **Example:** Postgres in Ashburn
 * ```typescript
 * export const Database = ClusterFly.Database("Cluster");
 * ```
 *
 * @primitive
 */
export const Database = (id: string, props: DatabaseProps = {}) =>
  Layer.effect(
    ClusterDatabase,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      const network = props.network ?? (yield* Fly.stackNetwork);
      const password = yield* Random(`${id}Password`, { bytes: 24 }) as unknown as Effect.Effect<
        Random,
        never,
        Providers
      >;
      const app = yield* Fly.App(`${id}App`, { network });
      const machine = yield* Fly.Machine(`${id}Postgres`, {
        app,
        region: props.region ?? "iad",
        image: props.image ?? "postgres:17-alpine",
        guest: props.guest ?? { cpus: 1, memoryMb: 1024 },
        mounts: [{ path: DATA, sizeGb: props.diskSize ?? 10 }],
        env: password.text.pipe(
          Output.map((text) => ({
            POSTGRES_PASSWORD: Redacted.value(text),
            POSTGRES_DB: "cluster",
            // A fresh volume holds `lost+found`: keep the data below it.
            PGDATA: `${DATA}/pgdata`,
          })),
        ) as unknown as Record<string, string>,
        restart: { policy: "always" },
      });
      return {
        // Ordered after the Machine: runners connect once it exists.
        url: Output.all(app.appName, machine.machineId, password.text).pipe(
          Output.map(([appName, , text]) =>
            Redacted.make(
              `postgres://postgres:${encodeURIComponent(text.pipe(Redacted.value))}@${appName}.internal:5432/cluster`,
            ),
          ),
        ),
        network: { kind: "fly" as const, network },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
