import * as athena from "@distilled.cloud/aws/athena";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { Output as OutputType } from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as AWSBindings from "../AWSBindings.ts";
import type { Bucket } from "../S3/Bucket.ts";
import type { WorkGroup } from "./WorkGroup.ts";

/**
 * The query request — the workgroup is injected by the binding (which also
 * supplies the enforced result location), so callers pass the SQL text and any
 * execution context/parameters as the raw distilled shape.
 */
export interface RunQueryRequest extends Omit<
  athena.StartQueryExecutionInput,
  "WorkGroup" | "ResultConfiguration"
> {}

/**
 * The fully-resolved result of a query: the terminal state plus the decoded
 * result set (column names + rows of string cells, exactly as Athena returns
 * them — the first row of a `SELECT` is the header).
 */
export interface QueryResult {
  readonly queryExecutionId: string;
  readonly state: athena.QueryExecutionState;
  readonly stateChangeReason: string | undefined;
  readonly columns: string[];
  readonly rows: string[][];
}

/**
 * Raised when a query reaches a terminal non-`SUCCEEDED` state (FAILED or
 * CANCELLED), or does not settle within the bounded poll window.
 */
export class AthenaQueryFailed extends Data.TaggedError("AthenaQueryFailed")<{
  readonly queryExecutionId: string;
  readonly state: string;
  readonly reason: string | undefined;
}> {}

/**
 * Run an Athena query end-to-end from a Lambda/Task: start the execution
 * against a bound workgroup, poll `GetQueryExecution` until it reaches a
 * terminal state (bounded), then read and decode the result set. Results are
 * written to the workgroup's enforced S3 output location in `resultsBucket`.
 *
 * ### Running Queries
 * **Example:** Query and read the result rows
 * ```typescript
 * const runQuery = yield* AWS.Athena.Query(workGroup, resultsBucket);
 * const result = yield* runQuery({ QueryString: "SELECT 1" });
 * // result.rows[0] === ["_col0"] (header), result.rows[1] === ["1"]
 * ```
 *
 * **Example:** Bind a WorkGroup to a Lambda Function
 * ```typescript
 * import * as Athena from "@alchemy.run/aws/Athena";
 * import * as Lambda from "@alchemy.run/aws/Lambda";
 * import * as S3 from "@alchemy.run/aws/S3";
 * import * as Output from "alchemy/Output";
 *
 * export class QueryFunction extends Lambda.Function<Lambda.Function>()(
 *   "QueryFunction",
 * ) {}
 *
 * export default QueryFunction.make(
 *   { main: import.meta.url, functionUrl: true, timeout: Duration.seconds(60) },
 *   Effect.gen(function* () {
 *     const bucket = yield* S3.Bucket("Results", { forceDestroy: true });
 *     const workGroup = yield* Athena.WorkGroup("Analytics", {
 *       outputLocation: Output.interpolate`s3://${bucket.bucketName}/results/`,
 *       enforceWorkGroupConfiguration: true,
 *     });
 *
 *     // grants athena:StartQueryExecution/GetQueryExecution/GetQueryResults
 *     // on the workgroup, S3 access on the results bucket, and Glue catalog
 *     // reads for table-backed queries
 *     const runQuery = yield* Athena.Query(workGroup, bucket);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* runQuery({
 *           QueryString: "SELECT COUNT(*) AS c FROM my_db.people",
 *         });
 *         return yield* HttpServerResponse.json({ rows: result.rows });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Athena.QueryHttp)),
 * );
 * ```
 *
 * @binding
 */
export interface Query extends Binding.Service<
  Query,
  "AWS.Athena.Query",
  (
    workGroup: WorkGroup,
    resultsBucket: Bucket,
  ) => Effect.Effect<
    (
      request: RunQueryRequest,
    ) => Effect.Effect<
      QueryResult,
      | athena.StartQueryExecutionError
      | athena.GetQueryExecutionError
      | athena.GetQueryResultsError
      | AthenaQueryFailed
    >
  >
> {}
export const Query = Binding.Service<Query>("AWS.Athena.Query");

// The workgroup ARN is `arn:aws:athena:{region}:{account}:workgroup/{name}` —
// the Glue Data Catalog ARNs share that partition/region/account.
const glueBase = (workGroupArn: OutputType<string>) =>
  workGroupArn.pipe(
    Output.map((arn) => {
      const [, partition, , region, account] = arn.split(":");
      return `arn:${partition}:glue:${region}:${account}`;
    }),
  );
const glueCatalogArn = (workGroupArn: OutputType<string>) =>
  glueBase(workGroupArn).pipe(Output.map((base) => `${base}:catalog`));
const glueDatabaseArn = (workGroupArn: OutputType<string>) =>
  glueBase(workGroupArn).pipe(Output.map((base) => `${base}:database/*`));
const glueTableArn = (workGroupArn: OutputType<string>) =>
  glueBase(workGroupArn).pipe(Output.map((base) => `${base}:table/*/*`));

export const QueryHttp = Layer.effect(
  Query,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startQueryExecution = yield* AWSBindings.withCredentials(athena.startQueryExecution);
    const getQueryExecution = yield* AWSBindings.withCredentials(athena.getQueryExecution);
    const getQueryResults = yield* AWSBindings.withCredentials(athena.getQueryResults);

    return Effect.fn(function* (workGroup: WorkGroup, resultsBucket: Bucket) {
      const WorkGroupName = yield* workGroup.workGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Athena.Query(${workGroup}, ${resultsBucket})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "athena:StartQueryExecution",
                "athena:GetQueryExecution",
                "athena:GetQueryResults",
                "athena:StopQueryExecution",
              ],
              Resource: [workGroup.workGroupArn],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetBucketLocation", "s3:ListBucket"],
              Resource: [resultsBucket.bucketArn],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
              Resource: [Output.interpolate`${resultsBucket.bucketArn}/*`],
            },
            {
              // Athena resolves table metadata through the Glue Data
              // Catalog on the caller's behalf — reads are required for any
              // query over a Glue-backed table. Scoped to the workgroup's
              // account/region catalog (derived from its ARN).
              Effect: "Allow",
              Action: [
                "glue:GetDatabase",
                "glue:GetDatabases",
                "glue:GetTable",
                "glue:GetTables",
                "glue:GetPartition",
                "glue:GetPartitions",
              ],
              Resource: [
                glueCatalogArn(workGroup.workGroupArn),
                glueDatabaseArn(workGroup.workGroupArn),
                glueTableArn(workGroup.workGroupArn),
              ],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Athena.Query(${workGroup.LogicalId})`)(function* (
        request: RunQueryRequest,
      ) {
        const workGroupName = yield* WorkGroupName;
        const started = yield* startQueryExecution({
          ...request,
          WorkGroup: workGroupName,
        });
        const queryExecutionId = started.QueryExecutionId!;

        // Poll GetQueryExecution until terminal — bounded to ~90s so a hung
        // query fails fast instead of hitting the caller's timeout.
        const exec = yield* getQueryExecution({
          QueryExecutionId: queryExecutionId,
        }).pipe(
          Effect.map((r) => r.QueryExecution),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (qe) => {
              const s = qe?.Status?.State;
              return s === "SUCCEEDED" || s === "FAILED" || s === "CANCELLED";
            },
            times: 90,
          }),
        );

        const state = exec?.Status?.State ?? "FAILED";
        const reason = exec?.Status?.StateChangeReason;
        if (state !== "SUCCEEDED") {
          return yield* new AthenaQueryFailed({ queryExecutionId, state, reason });
        }

        const results = yield* getQueryResults({
          QueryExecutionId: queryExecutionId,
        });
        const columns = (results.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []).map((c) => c.Name);
        const rows = (results.ResultSet?.Rows ?? []).map((row) =>
          (row.Data ?? []).map((d) => d.VarCharValue ?? ""),
        );
        return {
          queryExecutionId,
          state,
          stateChangeReason: reason,
          columns,
          rows,
        } satisfies QueryResult;
      });
    });
  }),
);
