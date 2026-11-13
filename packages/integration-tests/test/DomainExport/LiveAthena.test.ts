/**
 * Live (opt-in: `EXPORT_ATHENA_TEST=1` and `--tags export-live`): the
 * Iceberg store writing through AWS Glue's Iceberg REST endpoint into an S3
 * bucket, read by the Athena engine and by DuckDB. The file deploys the
 * bucket, a Glue database over it (named from the stage), an Athena
 * workgroup and a Lambda with `AWS.Athena.Query` bound
 * (`fixtures/athena-query.ts`), and destroys them when it ends.
 *
 * The Athena engine runs each query through that deployed binding. DuckDB
 * signs with the AWS credential chain, so the run's `AWS_PROFILE` (or keys)
 * must reach it. Not against an emulator (`AWS_ENDPOINT_URL`): DuckDB cannot
 * write through an emulated Glue.
 */
import * as AWS from "@alchemy.run/aws";
import { AthenaQueryFailed, type QueryResult, type RunQueryRequest } from "@alchemy.run/aws/Athena";
import * as ExportAthena from "@alchemy.run/domain/Export/Athena";
import * as DuckDbEngine from "@alchemy.run/domain/Export/DuckDb";
import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
import { describe } from "@alchemy.run/test";
import * as CoreModule from "@alchemy.run/test/Core";
import { Stage } from "alchemy/Stage";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { storeConformance } from "../Domain/export-conformance/conformance.ts";
import { EngineLake, engineConformance } from "../Domain/export-conformance/engines.ts";
import ExportAthenaQueryLive, {
  databaseNameOf,
  ExportAthenaQuery,
} from "./fixtures/athena-query.ts";
import {
  deployedWith,
  dockerShrinks,
  exportSuite,
  runsOr,
  testTimeout,
} from "./fixtures/docker.ts";
import type { LakeServices } from "./fixtures/iceberg.ts";
import { liveTag } from "./fixtures/live.ts";

const options = { providers: AWS.providers() };
const stack = CoreModule.scratchStack(options, "ExportAthena", import.meta.url);

/** The binding's answer, as the fixture sends it back. */
const Result = Schema.Struct({
  queryExecutionId: Schema.String,
  state: Schema.String,
  stateChangeReason: Schema.optional(Schema.String),
  columns: Schema.Array(Schema.String),
  types: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.String)),
  values: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
});
const Failure = Schema.Struct({
  queryExecutionId: Schema.String,
  state: Schema.String,
  reason: Schema.NullOr(Schema.String),
});

/** The fixture answered with a server error: a fresh function's grants can take seconds to apply. */
class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable")<{
  readonly status: number;
  readonly body: string;
}> {
  override get message() {
    return `the Athena fixture answered ${this.status}: ${this.body}`;
  }
}

/**
 * One query through the deployed binding: `AWS.Athena.Query`'s own call,
 * answered as the binding answers it (a failed query is its
 * `AthenaQueryFailed`).
 */
const runQueryAt =
  (url: string) =>
  (request: RunQueryRequest): Effect.Effect<QueryResult, AthenaQueryFailed | FixtureUnavailable> =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${url}/query`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            QueryString: request.QueryString,
            ExecutionParameters: request.ExecutionParameters,
          }),
        ),
      );
      if (response.status === 422) {
        const failure = yield* HttpClientResponse.schemaBodyJson(Failure)(response);
        return yield* new AthenaQueryFailed({
          queryExecutionId: failure.queryExecutionId,
          state: failure.state,
          reason: failure.reason ?? undefined,
        });
      }
      if (response.status !== 200)
        return yield* new FixtureUnavailable({
          status: response.status,
          body: yield* response.text,
        });
      const result = yield* HttpClientResponse.schemaBodyJson(Result)(response);
      return {
        queryExecutionId: result.queryExecutionId,
        // A cast: the fixture forwards the binding's own `QueryExecutionState`.
        state: result.state as QueryResult["state"],
        stateChangeReason: result.stateChangeReason,
        columns: [...result.columns],
        types: [...result.types],
        rows: result.rows.map((row) => [...row]),
        values: result.values.map((row) => [...row]),
      } satisfies QueryResult;
    }).pipe(
      Effect.catchTag(["HttpClientError", "SchemaError"], (cause) =>
        Effect.fail(new FixtureUnavailable({ status: 0, body: cause.message })),
      ),
      Effect.retry({
        while: (error) => error._tag === "FixtureUnavailable",
        schedule: Schedule.exponential("1 second"),
        times: 6,
      }),
      Effect.provide(FetchHttpClient.layer),
    );

/** What the deploy made for this run: the stage's Glue database, and the fixture's URL. */
class LiveAthena extends Context.Service<
  LiveAthena,
  { readonly namespace: string; readonly url: string }
>()("DomainExport/LiveAthena") {}

const environment = Layer.unwrap(
  Effect.gen(function* () {
    const deployed = yield* deployedWith(
      options,
      stack,
      Effect.gen(function* () {
        const fixture = yield* ExportAthenaQuery;
        return {
          stage: yield* Stage,
          functionUrl: fixture.functionUrl,
          functionArn: fixture.functionArn,
        };
      }).pipe(Effect.provide(ExportAthenaQueryLive)),
    );
    // The function's ARN names its region and account, which is the Glue warehouse:
    // `arn:aws:lambda:<region>:<account>:function:<name>`.
    const [, , , region = "", account = ""] = deployed.functionArn.split(":");
    return Layer.mergeAll(
      Layer.orDie(
        Iceberg.layer({
          catalog: new Iceberg.Glue({ warehouse: account, region }),
          storage: new Iceberg.S3({ region }),
        }),
      ),
      FetchHttpClient.layer,
      Layer.succeed(LiveAthena, {
        namespace: databaseNameOf(deployed.stage),
        url: (deployed.functionUrl ?? "").replace(/\/+$/, ""),
      }),
    );
  }),
);

const tags = {
  tags: ["provider:aws", "provider:aws:athena", "provider:aws:glue", "provider:aws:s3", "live"],
  optInTags: [liveTag],
};

type Services = LakeServices | LiveAthena;

describe.skipIf(!process.env.EXPORT_ATHENA_TEST || !!process.env.AWS_ENDPOINT_URL)(
  "Domain Export, live (Glue, read by Athena)",
  () =>
    exportSuite(environment, "Iceberg store and engines on Glue", (it) => {
      const test = (name: string, effect: Effect.Effect<void, unknown, Services>) =>
        it.effect(name, () => effect, { timeout: testTimeout, ...tags });
      const store = Effect.flatMap(LiveAthena, ({ namespace }) => Iceberg.store({ namespace }));
      storeConformance({
        test,
        make: store,
        kind: "live",
        runs: runsOr(2),
        maxShrinks: dockerShrinks,
      });
      // Each evaluation writes under a fresh physical name; the store resolves its promoted generation.
      engineConformance<Services>({
        test,
        dialect: "athena",
        layer: (analytics, physical) =>
          analytics
            .toLayer(
              Effect.gen(function* () {
                const { url } = yield* LiveAthena;
                const resolve = yield* Iceberg.names(EngineLake, { catalog: "awsdatacatalog" });
                return yield* ExportAthena.engine({
                  query: runQueryAt(url),
                  name: (table) => resolve({ ...table, spec: { ...table.spec, name: physical() } }),
                });
              }),
            )
            .pipe(Layer.provideMerge(EngineLake.toLayer(store))),
        freshNames: true,
        kind: "live",
        runs: runsOr(2),
        maxShrinks: dockerShrinks,
      });
      // DuckDB, attached to the same Glue catalog, reading what Athena reads.
      engineConformance<Services>({
        test: (name, effect) =>
          it.effect(`DuckDB: ${name}`, () => effect, { timeout: testTimeout, ...tags }),
        dialect: "duckdb",
        layer: (analytics, physical) =>
          analytics
            .toLayer(
              Effect.flatMap(Iceberg.names(EngineLake), (resolve) =>
                DuckDbEngine.engine({
                  name: (table) => resolve({ ...table, spec: { ...table.spec, name: physical() } }),
                }),
              ),
            )
            .pipe(Layer.provideMerge(EngineLake.toLayer(store))),
        freshNames: true,
        kind: "live",
        runs: runsOr(2),
        maxShrinks: dockerShrinks,
      });
    }),
);
