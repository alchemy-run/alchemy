/**
 * The live Athena suite's Lambda: `AWS.Athena.Query` bound to a workgroup
 * whose bucket holds both the lake's data files and the query results, so
 * the binding's grants cover reading the Iceberg tables. `POST /query` runs
 * one request through the binding as `Export.Athena.engine` sends it, and
 * answers with the binding's `QueryResult`, or its `AthenaQueryFailed` as a
 * 422. The test's Iceberg store writes into the Glue database deployed here,
 * named from the stage.
 *
 * The URL runs whatever SQL it is sent, in this workgroup, for as long as the
 * file's stack is deployed: the workgroup reads only this bucket.
 */
import * as Athena from "@alchemy.run/aws/Athena";
import * as Glue from "@alchemy.run/aws/Glue";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as S3 from "@alchemy.run/aws/S3";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "athena-query.ts");

/** The Glue database (and Iceberg namespace) of a stage: one per user, as Glue names are per account. */
export const databaseNameOf = (stage: string) =>
  `alchemy_export_${stage.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_")}`;

/** What `Export.Athena.engine` sends the binding. */
const QueryRequest = Schema.Struct({
  QueryString: Schema.String,
  ExecutionParameters: Schema.optionalKey(Schema.Array(Schema.String)),
});

export class ExportAthenaQuery extends Lambda.Function<Lambda.Function>()("ExportAthenaQuery") {}

export default ExportAthenaQuery.make(
  {
    main,
    functionUrl: true,
    // Start, poll and every result page: AWS's 3-second default would cut queries short.
    timeout: Duration.seconds(90),
  },
  Effect.gen(function* () {
    const database = databaseNameOf(yield* Stage);
    const bucket = yield* S3.Bucket("Lake", { forceDestroy: true });
    yield* Glue.Database("Exports", {
      databaseName: database,
      locationUri: Output.interpolate`s3://${bucket.bucketName}/lake/`,
    });
    const workGroup = yield* Athena.WorkGroup("Exports", {
      outputLocation: Output.interpolate`s3://${bucket.bucketName}/results/`,
      enforceWorkGroupConfiguration: true,
    });
    const query = yield* Athena.Query(workGroup, bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method !== "POST" || new URL(request.originalUrl).pathname !== "/query")
          return yield* HttpServerResponse.json({ error: "Not found" }, { status: 404 });
        const body = yield* Schema.decodeUnknownEffect(QueryRequest)(yield* request.json);
        return yield* query({
          QueryString: body.QueryString,
          ...(body.ExecutionParameters === undefined
            ? {}
            : { ExecutionParameters: [...body.ExecutionParameters] }),
          QueryExecutionContext: { Database: database },
        }).pipe(
          Effect.flatMap((result) => HttpServerResponse.json(result)),
          Effect.catchTag("AthenaQueryFailed", (failed) =>
            HttpServerResponse.json(
              {
                _tag: failed._tag,
                queryExecutionId: failed.queryExecutionId,
                state: failed.state,
                reason: failed.reason ?? null,
              },
              { status: 422 },
            ),
          ),
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Athena.QueryHttp)),
);
