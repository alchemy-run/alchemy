import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import type { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  ConnectPostgres,
  PostgresUrlMissing,
  connectEnvKeys,
  type ConnectPostgresClient,
} from "./ConnectPostgres.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import type { Postgres } from "./Postgres.ts";

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A>,
): Effect.Effect<A, never, RuntimeContext> =>
  output.bind(key).pipe(Effect.flatMap((effect) => effect));

const asRedactedUrl = (
  value: string,
  name: string,
): Effect.Effect<Redacted.Redacted<string>, PostgresUrlMissing> =>
  value.length > 0
    ? Effect.succeed(Redacted.make(value))
    : Effect.fail(new PostgresUrlMissing({ name }));

/**
 * Implementation of {@link ConnectPostgres}. Provide it on the
 * {@link Service} Effect.
 *
 * At deploy time this registers the cluster on the host so Service
 * reconcile can attach it (6PN) and packs the cluster's connection
 * URI Outputs into the Machine env. At runtime the client reads those
 * Outputs — the same channel Neon / Prisma / DSQL use.
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
      const keys = connectEnvKeys(postgres);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${postgres}`({
            postgres: { clusterId: postgres.clusterId },
            env: {
              [keys.pooled]: postgres.pooledConnectionUri,
              [keys.direct]: postgres.connectionUri,
            },
          });
        }
      }

      const pooled = runtimeOutput(keys.pooled, postgres.pooledConnectionUri);
      const direct = runtimeOutput(keys.direct, postgres.connectionUri);
      const name = postgres.LogicalId;

      return {
        connectionString: pooled.pipe(
          Effect.flatMap((value) =>
            value.length > 0
              ? asRedactedUrl(value, name)
              : direct.pipe(
                  Effect.flatMap((fallback) => asRedactedUrl(fallback, name)),
                ),
          ),
        ),
        directConnectionString: direct.pipe(
          Effect.flatMap((value) =>
            value.length > 0
              ? asRedactedUrl(value, name)
              : pooled.pipe(
                  Effect.flatMap((fallback) => asRedactedUrl(fallback, name)),
                ),
          ),
        ),
      } satisfies ConnectPostgresClient;
    }),
  ),
);
