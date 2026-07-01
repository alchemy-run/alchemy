import { RDSDataClient } from "@aws-sdk/client-rds-data";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import { drizzle as drizzleDataApi } from "drizzle-orm/aws-data-api/pg";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ExecutionContext } from "../../ExecutionContext.ts";
import { proxyChainPromise } from "../../Util/proxy-chain.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";
import { BatchExecuteStatement } from "./BatchExecuteStatement.ts";
import { BatchExecuteStatementHttp } from "./BatchExecuteStatementHttp.ts";
import { BeginTransaction } from "./BeginTransaction.ts";
import { BeginTransactionHttp } from "./BeginTransactionHttp.ts";
import { CommitTransaction } from "./CommitTransaction.ts";
import { CommitTransactionHttp } from "./CommitTransactionHttp.ts";
import { ExecuteStatement } from "./ExecuteStatement.ts";
import { ExecuteStatementHttp } from "./ExecuteStatementHttp.ts";
import { RollbackTransaction } from "./RollbackTransaction.ts";
import { RollbackTransactionHttp } from "./RollbackTransactionHttp.ts";

export interface DataApiOptions<TRelations extends AnyRelations> {
  /** Secrets Manager secret holding the cluster's credentials. */
  secret: Secret;
  /**
   * Database name to connect to.
   * @default "app"
   */
  database?: string;
  /** Optional drizzle relations (for the relational query API). */
  relations?: TRelations;
}

/**
 * Runtime Drizzle client backed by the **RDS Data API** — the AWS analog of
 * {@link import("../../Drizzle/Postgres.ts").postgres}, but speaking the Data
 * API over HTTPS+IAM instead of a `postgres://` connection. Ideal for Lambda
 * functions that stay out of the VPC.
 *
 * Like `Drizzle.postgres`, it returns a chainable proxy over the drizzle
 * database — query builders can be `yield*`-ed directly. The underlying
 * `RDSDataClient` + drizzle instance are built lazily and memoized on the
 * current `ExecutionContext`, so they're created at most once per invocation.
 * IAM for every Data API operation drizzle may issue (statements +
 * transactions) is attached at deploy time by binding the RDSData capabilities,
 * whose impl layers this binding provides itself — nothing extra to wire onto
 * the Function.
 *
 * @binding
 * @example
 * ```typescript
 * const db = yield* AWS.RDSData.drizzle(cluster, { secret, relations });
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* db.select().from(Users);
 *   return yield* HttpServerResponse.json({ users });
 * });
 * ```
 */
export const drizzle = <TRelations extends AnyRelations = EmptyRelations>(
  cluster: DBCluster,
  options: DataApiOptions<TRelations>,
) =>
  Effect.gen(function* () {
    const database = options.database ?? "app";
    // Attach IAM (deploy-time) for every Data API operation drizzle may issue by
    // binding each RDSData capability against the cluster. Binding a capability
    // registers its IAM policy statements on the host Function; we discard the
    // returned runtime client because this binding talks to the Data API through
    // its own `RDSDataClient`. The capability impl layers are provided below, so
    // the caller needs nothing extra on the Function.
    const bindOptions = { secret: options.secret, database };
    yield* ExecuteStatement(cluster, bindOptions);
    yield* BatchExecuteStatement(cluster, bindOptions);
    yield* BeginTransaction(cluster, bindOptions);
    yield* CommitTransaction(cluster, bindOptions);
    yield* RollbackTransaction(cluster, bindOptions);

    const resourceArn = yield* cluster.dbClusterArn;
    const secretArn = yield* options.secret.secretArn;

    const symbol = Symbol();
    // Typed as drizzle's effect-aware `EffectPgDatabase` — its query-builder
    // surface is structurally identical to the aws-data-api db, but every
    // terminal resolves to an `Effect`, which is exactly what `proxyChainPromise`
    // produces at runtime (it wraps the driver's `QueryPromise` thenables).
    return proxyChainPromise<
      EffectPgDatabase<TRelations> & { $client: RDSDataClient }
    >(
      Effect.gen(function* () {
        const ctx = yield* ExecutionContext;
        return yield* (ctx.cache[symbol] ??= yield* Effect.gen(function* () {
          const arn = yield* resourceArn;
          const sec = yield* secretArn;
          // Region + credentials resolve from the Lambda execution environment
          // via the AWS SDK default provider chain.
          const client = new RDSDataClient({});
          return drizzleDataApi({
            client,
            database,
            resourceArn: arn,
            secretArn: sec,
            relations: options.relations,
          });
        }).pipe(Effect.cached));
      }) as Effect.Effect<
        EffectPgDatabase<TRelations> & { $client: RDSDataClient }
      >,
    );
  }).pipe(
    // Provide the RDSData capability impl layers so binding them above attaches
    // IAM without the caller having to wire anything onto the Function. The
    // layers' own requirements (Credentials/Region/HttpClient) resolve from the
    // Lambda execution environment.
    Effect.provide(
      Layer.mergeAll(
        ExecuteStatementHttp,
        BatchExecuteStatementHttp,
        BeginTransactionHttp,
        CommitTransactionHttp,
        RollbackTransactionHttp,
      ),
    ),
  );

/** Friendly alias for {@link drizzle}. */
export const dataApi = drizzle;
