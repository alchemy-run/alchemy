import type { RuntimeContext } from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  Database,
  type DatabaseService,
  type DirectDatabase,
} from "./Database.ts";
import { BetterAuthMigrationError } from "./Errors.ts";

/**
 * Minimal shape of the RDS Data API surface the Kysely dialect drives —
 * promise-based so the same dialect serves the runtime (backed by the
 * `AWS.RDSData.*` bindings) and deploy-time migrations (backed by
 * distilled with ambient credentials).
 *
 * @internal
 */
export interface DataApiExecutor {
  readonly execute: (request: {
    sql: string;
    parameters?: SqlParameter[];
    includeResultMetadata?: boolean;
    transactionId?: string;
  }) => Promise<DataApiResponse>;
  readonly begin: () => Promise<{ transactionId?: string }>;
  readonly commit: (transactionId: string) => Promise<unknown>;
  readonly rollback: (transactionId: string) => Promise<unknown>;
}

interface SqlParameter {
  name: string;
  typeHint?: string;
  value: Record<string, unknown>;
}

interface DataApiField {
  stringValue?: string;
  longValue?: number;
  doubleValue?: number;
  booleanValue?: boolean;
  blobValue?: unknown;
  isNull?: boolean;
}

interface DataApiResponse {
  records?: DataApiField[][];
  columnMetadata?: { label?: string; name?: string; typeName?: string }[];
  numberOfRecordsUpdated?: number;
}

const toSqlParameter = (name: string, value: unknown): SqlParameter => {
  if (value === null || value === undefined) {
    return { name, value: { isNull: true } };
  }
  if (typeof value === "string") {
    return { name, value: { stringValue: value } };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { name, value: { longValue: value } }
      : { name, value: { doubleValue: value } };
  }
  if (typeof value === "bigint") {
    return { name, value: { longValue: Number(value) } };
  }
  if (typeof value === "boolean") {
    return { name, value: { booleanValue: value } };
  }
  if (value instanceof Date) {
    return {
      name,
      typeHint: "TIMESTAMP",
      value: {
        stringValue: value.toISOString().replace("T", " ").replace("Z", ""),
      },
    };
  }
  if (value instanceof Uint8Array) {
    return { name, value: { blobValue: value } };
  }
  return { name, value: { stringValue: JSON.stringify(value) } };
};

const TIMESTAMP_TYPES = new Set([
  "timestamp",
  "timestamptz",
  "date",
  "datetime",
]);

const fieldValue = (
  field: DataApiField,
  typeName: string | undefined,
): unknown => {
  if (field.isNull) {
    return null;
  }
  if (field.stringValue !== undefined) {
    if (typeName !== undefined && TIMESTAMP_TYPES.has(typeName.toLowerCase())) {
      // Data API returns UTC timestamps as "YYYY-MM-DD HH:MM:SS[.FFF]"
      const iso = field.stringValue.replace(" ", "T");
      return new Date(/[Z+]/.test(iso.slice(10)) ? iso : `${iso}Z`);
    }
    return field.stringValue;
  }
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return field.blobValue;
  return null;
};

const toRows = (response: DataApiResponse): Record<string, unknown>[] => {
  const metadata = response.columnMetadata ?? [];
  return (response.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};
    record.forEach((field, index) => {
      const column = metadata[index];
      row[column?.label ?? column?.name ?? `column${index}`] = fieldValue(
        field,
        column?.typeName,
      );
    });
    return row;
  });
};

/**
 * Build a Kysely dialect over the RDS Data API.
 *
 * Postgres-flavoured, with `$n` placeholders rewritten to the Data API's
 * named `:n` parameters. Streaming is unsupported (the Data API is
 * request/response).
 *
 * @internal
 */
export const makeDataApiDialect = (
  executor: DataApiExecutor,
): Effect.Effect<import("kysely").Dialect> =>
  Effect.promise(async () => {
    const {
      CompiledQuery,
      PostgresAdapter,
      PostgresIntrospector,
      PostgresQueryCompiler,
    } = await import("kysely");
    void CompiledQuery;

    class DataApiQueryCompiler extends PostgresQueryCompiler {
      protected override getCurrentParameterPlaceholder(): string {
        return `:${this.numParameters}`;
      }
    }

    class DataApiConnection {
      transactionId: string | undefined;

      async executeQuery(compiledQuery: {
        sql: string;
        parameters: ReadonlyArray<unknown>;
      }) {
        const response = await executor.execute({
          sql: compiledQuery.sql,
          parameters: compiledQuery.parameters.map((value, index) =>
            toSqlParameter(`${index + 1}`, value),
          ),
          includeResultMetadata: true,
          ...(this.transactionId === undefined
            ? {}
            : { transactionId: this.transactionId }),
        });
        return {
          rows: toRows(response) as never[],
          numAffectedRows: BigInt(response.numberOfRecordsUpdated ?? 0),
        };
      }

      async *streamQuery(): AsyncIterableIterator<never> {
        throw new Error("RDS Data API does not support streaming queries");
      }
    }

    class DataApiDriver {
      async init() {}
      async acquireConnection() {
        return new DataApiConnection();
      }
      async beginTransaction(connection: DataApiConnection) {
        const { transactionId } = await executor.begin();
        connection.transactionId = transactionId;
      }
      async commitTransaction(connection: DataApiConnection) {
        if (connection.transactionId !== undefined) {
          await executor.commit(connection.transactionId);
          connection.transactionId = undefined;
        }
      }
      async rollbackTransaction(connection: DataApiConnection) {
        if (connection.transactionId !== undefined) {
          await executor.rollback(connection.transactionId);
          connection.transactionId = undefined;
        }
      }
      async releaseConnection() {}
      async destroy() {}
    }

    return {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DataApiDriver(),
      createQueryCompiler: () => new DataApiQueryCompiler(),
      createIntrospector: (db: never) => new PostgresIntrospector(db),
    } as unknown as import("kysely").Dialect;
  });

export interface AuroraDataApiOptions {
  /**
   * Secrets Manager secret holding the database credentials (Aurora's
   * managed master secret, or one you provision).
   */
  readonly secret: AWS.SecretsManager.Secret;
  /** Database name inside the cluster. */
  readonly database?: string;
  /**
   * Deploy-time automatic migration (over the Data API with ambient
   * credentials). `false` disables.
   * @default enabled
   */
  readonly migrate?: false;
}

/**
 * Aurora (RDS Data API) database layer for {@link BetterAuth} — the
 * optimal Lambda → Aurora pairing: SQL over HTTPS with IAM auth, no VPC
 * attachment, no `pg`, no connection pooling concerns.
 *
 * Runtime access flows through the `AWS.RDSData.*` bindings, which grant
 * the host `rds-data:*` + `secretsmanager:GetSecretValue` IAM and inject
 * the cluster/secret ARNs. Requires the cluster to have the Data API
 * enabled (`AWS.RDS.Aurora` enables it by default).
 *
 * ```typescript
 * export default AuthFunction.make(
 *   { main, url: true },
 *   Effect.gen(function* () {
 *     const db = yield* AWS.RDS.Aurora("AuthDb", { ... });
 *     const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *     return { fetch: ... };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.unwrap(
 *         Effect.map(AWS.RDS.Aurora("AuthDb", { ... }), (db) =>
 *           AuroraDataApi(db.cluster, { secret: db.secret, database: "auth" }),
 *         ),
 *       ),
 *     ),
 *     Effect.provide(AWS.RDSData.ExecuteStatementHttp),
 *     Effect.provide(AWS.RDSData.BeginTransactionHttp),
 *     Effect.provide(AWS.RDSData.CommitTransactionHttp),
 *     Effect.provide(AWS.RDSData.RollbackTransactionHttp),
 *   ),
 * );
 * ```
 *
 * `kysely` and `@distilled.cloud/aws` are optional peer dependencies of
 * this layer.
 */
export const AuroraDataApi = (
  cluster: AWS.RDS.DBCluster | Effect.Effect<AWS.RDS.DBCluster, never, any>,
  options: AuroraDataApiOptions,
) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const db = Effect.isEffect(cluster)
        ? yield* cluster as Effect.Effect<AWS.RDS.DBCluster>
        : cluster;
      const bindingOptions = {
        secret: options.secret,
        ...(options.database === undefined
          ? {}
          : { database: options.database }),
      };
      const executeStatement = yield* AWS.RDSData.ExecuteStatement(
        db,
        bindingOptions,
      );
      const beginTransaction = yield* AWS.RDSData.BeginTransaction(
        db,
        bindingOptions,
      );
      const commitTransaction = yield* AWS.RDSData.CommitTransaction(
        db,
        bindingOptions,
      );
      const rollbackTransaction = yield* AWS.RDSData.RollbackTransaction(
        db,
        bindingOptions,
      );

      const runtime = Effect.gen(function* () {
        const context = yield* Effect.context<RuntimeContext>();
        const run = <A, E>(
          effect: Effect.Effect<A, E, RuntimeContext>,
        ): Promise<A> =>
          Effect.runPromise(
            effect.pipe(Effect.provideContext(context)) as Effect.Effect<A, E>,
          );
        const dialect = yield* makeDataApiDialect({
          execute: (request) =>
            run(
              executeStatement(request as AWS.RDSData.ExecuteStatementRequest),
            ),
          begin: () => run(beginTransaction()),
          commit: (transactionId) => run(commitTransaction({ transactionId })),
          rollback: (transactionId) =>
            run(rollbackTransaction({ transactionId })),
        });
        return { dialect, type: "postgres" as const };
      });

      const service: DatabaseService = {
        provider: "postgres",
        runtime: runtime as DatabaseService["runtime"],
      };

      // Deploy-time migrations call the Data API through distilled with the
      // ambient stack credentials (mirroring D1's deploy-time HTTP client).
      // DCE'd from runtime bundles.
      if (!globalThis.__ALCHEMY_RUNTIME__ && options.migrate !== false) {
        return {
          ...service,
          migrate: {
            identity: { clusterArn: db.dbClusterArn } as Record<
              string,
              unknown
            >,
            connect: Effect.gen(function* () {
              // Init half — capture the ARNs as Action dependencies.
              const clusterArn = yield* db.dbClusterArn;
              const secretArn = yield* options.secret.secretArn;
              const ambient = yield* Effect.context<never>();
              // Apply half — Data API dialect over distilled.
              return Effect.gen(function* () {
                const resourceArn = yield* clusterArn;
                const resolvedSecretArn = yield* secretArn;
                const rdsdata = yield* Effect.promise(
                  () => import("@distilled.cloud/aws/rds-data"),
                );
                const base = {
                  resourceArn,
                  secretArn: resolvedSecretArn,
                  ...(options.database === undefined
                    ? {}
                    : { database: options.database }),
                };
                const run = <A>(effect: Effect.Effect<A, any, any>) =>
                  Effect.runPromise(
                    effect.pipe(
                      Effect.provideContext(ambient),
                    ) as Effect.Effect<A>,
                  );
                const dialect = yield* makeDataApiDialect({
                  execute: (request) =>
                    run(
                      rdsdata.executeStatement({
                        ...base,
                        ...request,
                      } as never),
                    ),
                  begin: () => run(rdsdata.beginTransaction(base)),
                  commit: (transactionId) =>
                    run(
                      rdsdata.commitTransaction({
                        resourceArn,
                        secretArn: resolvedSecretArn,
                        transactionId,
                      }),
                    ),
                  rollback: (transactionId) =>
                    run(
                      rdsdata.rollbackTransaction({
                        resourceArn,
                        secretArn: resolvedSecretArn,
                        transactionId,
                      }),
                    ),
                });
                return { dialect, type: "postgres" } as DirectDatabase;
              }).pipe(
                Effect.catchDefect((cause: unknown) =>
                  Effect.fail(
                    new BetterAuthMigrationError({
                      message:
                        "Failed to reach the Aurora Data API for Better Auth schema migrations",
                      cause,
                    }),
                  ),
                ),
              );
            }) as Effect.Effect<
              Effect.Effect<
                DirectDatabase,
                BetterAuthMigrationError,
                Scope.Scope
              >,
              never,
              RuntimeContext
            >,
          },
        } satisfies DatabaseService;
      }
      return service;
    }),
  ).pipe(
    Layer.provide(AWS.RDSData.ExecuteStatementHttp),
    Layer.provide(AWS.RDSData.BeginTransactionHttp),
    Layer.provide(AWS.RDSData.CommitTransactionHttp),
    Layer.provide(AWS.RDSData.RollbackTransactionHttp),
  );
