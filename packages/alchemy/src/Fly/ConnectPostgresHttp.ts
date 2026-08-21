import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import {
  ConnectPostgres,
  PostgresUrlMissing,
  type ConnectPostgresClient,
} from "./ConnectPostgres.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import {
  DATABASE_URL_SECRET,
  DIRECT_DATABASE_URL_SECRET,
  type Postgres,
} from "./Postgres.ts";

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const urlFromEnv = (name: string, logicalId: string) =>
  Config.redacted(name).pipe(
    Effect.mapError(
      () =>
        new PostgresUrlMissing({
          name: logicalId,
        }),
    ),
  );

/**
 * Implementation of {@link ConnectPostgres}. Provide it on the
 * {@link Service} Effect.
 *
 * At deploy time this registers the cluster on the host so Service
 * reconcile can attach it (6PN + `DATABASE_URL`). At runtime the
 * connection strings are read from the Machine environment.
 *
 * @layer
 * @provides Fly.ConnectPostgres
 *
 * @section Provide the layer
 * @example On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const conn = yield* Fly.ConnectPostgres(Db);
 *   const db = yield* Drizzle.Postgres(conn.connectionString);
 * }).pipe(Effect.provide(Fly.ConnectPostgresHttp))
 * ```
 */
export const ConnectPostgresHttp = Layer.effect(
  ConnectPostgres,
  Effect.succeed(
    Effect.fn(function* (postgres: Postgres) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${postgres}`({
            postgres: { clusterId: postgres.clusterId },
          });
        }
      }

      const logicalId = postgres.LogicalId;
      const pooled = urlFromEnv(DATABASE_URL_SECRET, logicalId);
      const direct = urlFromEnv(DIRECT_DATABASE_URL_SECRET, logicalId).pipe(
        Effect.orElse(() => pooled),
      );

      return {
        connectionString: pooled,
        directConnectionString: direct,
      } satisfies ConnectPostgresClient;
    }),
  ),
);
