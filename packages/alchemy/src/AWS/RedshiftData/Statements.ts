import type * as data from "@distilled.cloud/aws/redshift-data";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workgroup } from "../RedshiftServerless/Workgroup.ts";

/**
 * Options that pin every statement run through this binding to a database and,
 * optionally, an authentication method.
 */
export interface StatementsOptions {
  /**
   * Database to run statements against.
   * @default "dev"
   */
  database?: string;
  /**
   * ARN of a Secrets Manager secret holding the database credentials. Omit to
   * authenticate with the Lambda's IAM identity via
   * `redshift-serverless:GetCredentials`.
   */
  secretArn?: string;
  /**
   * Database user to connect as. Only used with secret/temporary-credential
   * auth flows that require an explicit user.
   */
  dbUser?: string;
}

/**
 * `executeStatement` input minus the identifiers this binding injects
 * (workgroup, database, and the cluster-only fields).
 */
export interface ExecuteStatementRequest extends Omit<
  data.ExecuteStatementInput,
  "WorkgroupName" | "Database" | "ClusterIdentifier" | "SecretArn" | "DbUser"
> {}

/**
 * Raised when a statement reaches a terminal `FAILED` or `ABORTED` status
 * while a composite `query` waits for it to finish.
 */
export class RedshiftStatementFailed extends Data.TaggedError(
  "RedshiftStatementFailed",
)<{
  /**
   * ID of the failed statement.
   */
  readonly statementId: string;
  /**
   * Terminal status the statement ended in (`"FAILED"` or `"ABORTED"`).
   */
  readonly status: string;
  /**
   * Error message reported by Redshift, if any.
   */
  readonly error: string | undefined;
}> {}

/**
 * Runtime client for the Redshift Data API scoped to a single workgroup +
 * database.
 */
export interface StatementsClient {
  /**
   * Submit a SQL statement. Returns immediately with the statement `Id`;
   * results are fetched asynchronously via {@link describe}/{@link getResult}.
   */
  readonly execute: (
    request: ExecuteStatementRequest,
  ) => Effect.Effect<data.ExecuteStatementOutput, data.ExecuteStatementError>;
  /**
   * Describe a submitted statement (status, timing, row counts).
   */
  readonly describe: (
    id: string,
  ) => Effect.Effect<
    data.DescribeStatementResponse,
    data.DescribeStatementError
  >;
  /**
   * Fetch the cached result rows of a finished statement.
   */
  readonly getResult: (
    id: string,
  ) => Effect.Effect<
    data.GetStatementResultResponse,
    data.GetStatementResultError
  >;
  /**
   * Run a SQL statement and wait (bounded) for it to finish, returning its
   * result rows. Fails with {@link RedshiftStatementFailed} if the statement
   * ends in `FAILED`/`ABORTED`.
   */
  readonly query: (
    sql: string,
    parameters?: data.SqlParameter[],
  ) => Effect.Effect<
    data.GetStatementResultResponse,
    | data.ExecuteStatementError
    | data.DescribeStatementError
    | data.GetStatementResultError
    | RedshiftStatementFailed
  >;
}

/**
 * Runtime binding for the Amazon Redshift Data API against a Serverless
 * {@link Workgroup}. Exposes `execute`/`describe`/`getResult` plus a composite
 * `query` that submits a statement and polls until it finishes.
 *
 * At deploy time it grants `redshift-data:*` on the workgroup (plus
 * `redshift-serverless:GetCredentials` for IAM auth) and publishes the
 * workgroup name to the host Function. The Data API is HTTP-based — no
 * driver, no VPC reach, and no credential plumbing required. Provide the
 * implementation with `Effect.provide(AWS.RedshiftData.StatementsHttp)`.
 *
 * @binding
 * @section Running SQL
 * @example Query a Workgroup
 * ```typescript
 * const sql = yield* RedshiftData.Statements(workgroup, { database: "dev" });
 * const result = yield* sql.query("SELECT 1 AS n");
 * // result.Records -> [[{ longValue: 1 }]]
 * ```
 *
 * @example Serve Query Results from a Lambda Function
 * ```typescript
 * export default QueryFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const namespace = yield* RedshiftServerless.Namespace("Analytics", {
 *       dbName: "analytics",
 *       adminUsername: "admin",
 *       manageAdminPassword: true,
 *     });
 *     const workgroup = yield* RedshiftServerless.Workgroup("Analytics", {
 *       namespaceName: namespace.namespaceName,
 *       baseCapacity: 8,
 *     });
 *     // init — bind the Data API to the workgroup
 *     const sql = yield* RedshiftData.Statements(workgroup, {
 *       database: "analytics",
 *     });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — submit a statement and wait for its rows
 *         const result = yield* sql.query("SELECT count(*) AS n FROM events");
 *         return yield* HttpServerResponse.json({ records: result.Records });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(RedshiftData.StatementsHttp)),
 * );
 * ```
 */
export interface Statements extends Binding.Service<
  Statements,
  "AWS.RedshiftData.Statements",
  (
    workgroup: Workgroup,
    options?: StatementsOptions,
  ) => Effect.Effect<StatementsClient>
> {}

export const Statements = Binding.Service<Statements>(
  "AWS.RedshiftData.Statements",
);
