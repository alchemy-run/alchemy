import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  ConnectPostgres,
  DATABASE_URL_ENV,
  PostgresUrlMissing,
  connectPostgresEnvKeys,
  type ConnectPostgresClient,
} from "./ConnectPostgres.ts";
import type { Postgres, PostgresConnectionInfo } from "./Postgres.ts";
import * as RenderBindings from "./RenderBindings.ts";

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A> | A,
): Effect.Effect<A, never, RuntimeContext> =>
  Output.isOutput(output)
    ? output.bind(key).pipe(Effect.flatMap((effect) => effect))
    : Effect.succeed(output);

const readConfigRedacted = (key: string): Effect.Effect<Redacted.Redacted<string> | undefined> =>
  Config.Redacted(key).pipe(
    Config.option,
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );

const firstNonEmptyRedacted = (
  candidates: ReadonlyArray<
    Effect.Effect<Redacted.Redacted<string> | undefined, never, RuntimeContext>
  >,
  resourceName: string,
): Effect.Effect<Redacted.Redacted<string>, PostgresUrlMissing, RuntimeContext> =>
  Effect.gen(function* () {
    for (const candidate of candidates) {
      const value = yield* candidate;
      if (value !== undefined && Redacted.value(value).length > 0) {
        return value;
      }
    }
    return yield* new PostgresUrlMissing({ resourceName });
  });

const fromRuntimeOrConfig = (
  key: string,
  output: Output.Output<Redacted.Redacted<string>>,
): Effect.Effect<Redacted.Redacted<string> | undefined, never, RuntimeContext> =>
  Effect.gen(function* () {
    const rt = yield* CurrentRuntimeContext;
    if (rt) {
      const stored = yield* rt.get<string | Redacted.Redacted<string>>(sanitizeKey(key));
      if (Redacted.isRedacted(stored) && Redacted.value(stored).length > 0) {
        return stored;
      }
      if (typeof stored === "string" && stored.length > 0) {
        return Redacted.make(stored);
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const value = yield* runtimeOutput(key, output);
        if (value !== undefined && Redacted.value(value).length > 0) {
          return value;
        }
      }
    }
    return yield* readConfigRedacted(key);
  });

const extractPooledOutputs = (
  connInfo: Output.Output<PostgresConnectionInfo> | PostgresConnectionInfo,
): {
  readonly internal: Output.Output<Redacted.Redacted<string>> | Redacted.Redacted<string>;
  readonly external: Output.Output<Redacted.Redacted<string>> | Redacted.Redacted<string>;
} => {
  if (Output.isOutput(connInfo)) {
    return {
      internal: Output.map(
        connInfo,
        (info) => info.pooledInternalConnectionString ?? info.internalConnectionString,
      ),
      external: Output.map(
        connInfo,
        (info) => info.pooledExternalConnectionString ?? info.externalConnectionString,
      ),
    };
  }
  return {
    internal: connInfo.pooledInternalConnectionString ?? connInfo.internalConnectionString,
    external: connInfo.pooledExternalConnectionString ?? connInfo.externalConnectionString,
  };
};

/**
 * HTTP implementation of {@link ConnectPostgres}.
 *
 * At deploy time on Render hosts, injects `DATABASE_URL`,
 * `RENDER_POSTGRES_<ID>_INTERNAL`, and `RENDER_POSTGRES_<ID>_EXTERNAL` via the
 * ambient `RuntimeContext`. On foreign runtime hosts, binds the external URLs
 * and prefers external TLS connections.
 *
 * **Example:** Provide `ConnectPostgresHttp` to runtime code
 * ```typescript
 * Effect.gen(function* () {
 *   const conn = yield* Render.ConnectPostgres(mainDb);
 *   const url = yield* conn.connectionString;
 *   return url;
 * }).pipe(Effect.provide(Render.ConnectPostgresHttp));
 * ```
 *
 * @layer
 * @product Postgres
 * @provides Render.ConnectPostgres
 */
export const ConnectPostgresHttp = Layer.effect(
  ConnectPostgres,
  Effect.gen(function* () {
    const bind = yield* RenderBindings.Bind;
    return Effect.fn(function* (postgres: Postgres) {
      const keys = connectPostgresEnvKeys(postgres);
      const resourceName = postgres.LogicalId;
      const rt = yield* CurrentRuntimeContext;
      const isRenderRuntime = rt?.Type.startsWith("Render.") ?? false;
      let preferExternal = !isRenderRuntime;

      const pooled = extractPooledOutputs(postgres.connectionInfo);
      const pooledInternalOutput = pooled.internal;
      const pooledExternalOutput = pooled.external;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        preferExternal = !isRenderRuntime;
        yield* bind`Render.ConnectPostgres(${postgres})`({
          env: isRenderRuntime
            ? {
                [keys.internal]: postgres.connectionInfo.internalConnectionString,
                [keys.external]: postgres.connectionInfo.externalConnectionString,
                [keys.pooledInternal]: pooledInternalOutput,
                [keys.pooledExternal]: pooledExternalOutput,
                [DATABASE_URL_ENV]: postgres.connectionInfo.internalConnectionString,
              }
            : {
                [sanitizeKey(keys.external)]: postgres.connectionInfo.externalConnectionString,
                [sanitizeKey(keys.pooledExternal)]: Output.asOutput(pooledExternalOutput),
              },
        });
      }

      const internalCandidate = fromRuntimeOrConfig(
        keys.internal,
        postgres.connectionInfo.internalConnectionString,
      );
      const externalCandidate = fromRuntimeOrConfig(
        keys.external,
        postgres.connectionInfo.externalConnectionString,
      );
      const pooledInternalCandidate = fromRuntimeOrConfig(
        keys.pooledInternal,
        Output.asOutput(pooledInternalOutput),
      );
      const pooledExternalCandidate = fromRuntimeOrConfig(
        keys.pooledExternal,
        Output.asOutput(pooledExternalOutput),
      );
      const databaseUrlConfig = readConfigRedacted(DATABASE_URL_ENV);

      const internalConnectionString = firstNonEmptyRedacted(
        [internalCandidate, databaseUrlConfig, externalCandidate],
        resourceName,
      );
      const externalConnectionString = firstNonEmptyRedacted(
        [externalCandidate, databaseUrlConfig, internalCandidate],
        resourceName,
      );
      const pooledInternalConnectionString = firstNonEmptyRedacted(
        [pooledInternalCandidate, internalCandidate, databaseUrlConfig, externalCandidate],
        resourceName,
      );
      const pooledExternalConnectionString = firstNonEmptyRedacted(
        [pooledExternalCandidate, externalCandidate, databaseUrlConfig, internalCandidate],
        resourceName,
      );

      return {
        connectionString: preferExternal ? externalConnectionString : internalConnectionString,
        internalConnectionString,
        externalConnectionString,
        pooledConnectionString: preferExternal
          ? pooledExternalConnectionString
          : pooledInternalConnectionString,
        pooledInternalConnectionString,
        pooledExternalConnectionString,
      } satisfies ConnectPostgresClient;
    });
  }),
);
