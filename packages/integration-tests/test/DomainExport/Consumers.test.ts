import { join } from "node:path";
/**
 * Tier C (opt-in: `--tags export-lakes`). Consumers written by hand against
 * an exported lake: a FastAPI service, a data scientist's notebook in
 * pandas, Polars and DuckDB, and Spark SQL on the stable name. Each runs
 * from an image built for it (`consumers/*.Dockerfile`, every dependency
 * fixed at build time), deployed with the lake, and is asked:
 *
 * - after every step of generated sequences of writes, retries, rebuilds
 *   and promotions, where every answer must be the model's;
 * - while the writer runs, where every answer must be the model's for some
 *   state the lake passed through during that read.
 */
import * as Docker from "@alchemy.run/docker";
import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
import { expect } from "@alchemy.run/test";
import type { Output } from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Arbitrary from "effect/Arbitrary";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  agree,
  answersDuring,
  applySequence,
  fresh,
  type Model,
  ops,
  race,
  raceOps,
} from "../Domain/export-conformance/conformance.ts";
import { modelAnswers } from "../Domain/export-conformance/engines.ts";
import {
  dockerShrinks,
  exportSuite,
  httpOk,
  lakesTag,
  publish,
  type Published,
  runsOr,
  send,
  testTimeout,
  waitFor,
} from "./fixtures/docker.ts";
import { exportLayer, type Lake, startLake } from "./fixtures/lake.ts";

const consumers = join(import.meta.dir, "consumers");
const namespace = "consumers";
/** The engine suite's timestamp question: rows before the third second (an offset, which Python 3.10 parses). */
const earlyBefore = "2026-01-01T00:00:03+00:00";
const tags = { tags: ["local", "docker"], optInTags: [lakesTag] };

/** What every consumer reads its lake from, by aliases inside the lake's network (the REST fixture's catalog). */
const lakeEnvironment = {
  LAKE_NAMESPACE: namespace,
  LAKE_EARLY_BEFORE: earlyBefore,
  LAKE_CATALOG_URI: "http://catalog:8181",
  LAKE_S3_ENDPOINT: "http://minio:9000",
  AWS_ACCESS_KEY_ID: "admin",
  AWS_SECRET_ACCESS_KEY: "password",
  AWS_REGION: "us-east-1",
};

/** The consumers, deployed on the lake's network: images built from `consumers/`, then their servers. */
const consumerContainers =
  (published: {
    readonly service: Published;
    readonly notebook: Published;
    readonly spark: Published;
  }) =>
  (network: Output<string>) =>
    Effect.gen(function* () {
      // Named by the stack, stage and logical id: concurrent runs build images of their own.
      const python = yield* Docker.Image("ConsumerPython", {
        build: { context: consumers, dockerfile: join(consumers, "python.Dockerfile") },
        skipPush: true,
      });
      const sparkImage = yield* Docker.Image("ConsumerSpark", {
        build: { context: consumers, dockerfile: join(consumers, "spark.Dockerfile") },
        skipPush: true,
      });
      const server = (id: string, image: typeof python, app: string, ports: Published) =>
        Docker.Container(id, {
          image,
          command: ["uvicorn", app, "--host", "0.0.0.0", "--port", "8000"],
          environment: lakeEnvironment,
          ports: [ports.mapping],
          networks: [{ name: network }],
          start: true,
          memory: "2g",
        });
      yield* server("Service", python, "service:app", published.service);
      yield* server("Notebook", python, "scientist:app", published.notebook);
      yield* Docker.Container("Spark", {
        image: sparkImage,
        command: [
          "/opt/spark/bin/spark-submit",
          ...[
            "spark.sql.session.timeZone=UTC",
            "spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions",
            "spark.sql.catalog.lake=org.apache.iceberg.spark.SparkCatalog",
            "spark.sql.catalog.lake.type=rest",
            "spark.sql.catalog.lake.uri=http://catalog:8181",
            // Every query loads the view and table afresh: a cached one would answer for an old state.
            "spark.sql.catalog.lake.cache-enabled=false",
            "spark.sql.catalog.lake.io-impl=org.apache.iceberg.aws.s3.S3FileIO",
            "spark.sql.catalog.lake.s3.endpoint=http://minio:9000",
            "spark.sql.catalog.lake.s3.path-style-access=true",
            "spark.sql.catalog.lake.client.region=us-east-1",
          ].flatMap((conf) => ["--conf", conf]),
          "/consumers/spark.py",
        ],
        environment: lakeEnvironment,
        ports: [published.spark.mapping],
        networks: [{ name: network }],
        start: true,
        cpus: 2,
        memory: "2g",
      });
      return {};
    });

const Answers = Schema.Struct({
  perKey: Schema.Array(Schema.Struct({ key: Schema.String, rows: Schema.Number })),
  positions: Schema.Array(Schema.Struct({ key: Schema.String, position: Schema.Number })),
  early: Schema.Number,
  noMemo: Schema.Number,
});
type Answers = typeof Answers.Type;
const SparkAnswers = Answers.mapFields((fields) => ({ ...fields, views: Schema.Number }));

class ReaderFailed extends Data.TaggedError("ReaderFailed")<{
  readonly reader: string;
  readonly detail: string;
}> {
  override get message() {
    return `${this.reader}: ${this.detail}`;
  }
}

/** A GET to a reader, decoded; a non-2xx answer or a bad body is the reader's failure. */
const ask = <S extends Schema.Top>(reader: string, schema: S, url: string) =>
  send(url).pipe(
    Effect.mapError((cause) => new ReaderFailed({ reader, detail: cause.message })),
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.mapError((issue) => new ReaderFailed({ reader, detail: String(issue) })),
      ),
    ),
  );

/** Where each consumer answers on the host: chosen before the deploy, stable across restarts. */
let servicePort = 0;
let notebookPort = 0;
let sparkPort = 0;

const at = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;

/** Every reader's answers for `table`. `atomic`: each reader answers from one read of one generation. */
const askAll = (table: string, atomic: boolean) => {
  const q = `table=${encodeURIComponent(table)}`;
  const api = atomic
    ? ask("FastAPI", Answers, at(servicePort, `/answers?${q}`))
    : Effect.all({
        perKey: ask("FastAPI", Answers.fields.perKey, at(servicePort, `/accounts?${q}`)),
        positions: ask(
          "FastAPI",
          Answers.fields.positions,
          at(servicePort, `/accounts/a2/positions?since=1&${q}`),
        ),
        stats: ask(
          "FastAPI",
          Answers.mapFields(({ early, noMemo }) => ({ early, noMemo })),
          at(servicePort, `/stats?${q}`),
        ),
      }).pipe(Effect.map(({ perKey, positions, stats }) => ({ perKey, positions, ...stats })));
  return Effect.all(
    {
      FastAPI: api,
      pandas: ask("pandas", Answers, at(notebookPort, `/pandas?${q}`)),
      Polars: ask("Polars", Answers, at(notebookPort, `/polars?${q}`)),
      "DuckDB Python": ask("DuckDB Python", Answers, at(notebookPort, `/duckdb?${q}`)),
      "Spark SQL": ask("Spark SQL", SparkAnswers, at(sparkPort, `/answers?${q}`)),
    },
    { concurrency: "unbounded" },
  );
};

/** The model's answers, positions in position order as every reader gives them. */
const want = (model: Model): Answers => {
  const answers = modelAnswers(model);
  return {
    ...answers,
    positions: [...answers.positions].sort((a, b) => a.position - b.position),
  };
};

/** Spark's answers without its view count, after checking that it read a view. */
const sparkRead = (spark: typeof SparkAnswers.Type) =>
  spark.views === 1
    ? Effect.succeed({
        perKey: spark.perKey,
        positions: spark.positions,
        early: spark.early,
        noMemo: spark.noMemo,
      })
    : Effect.fail(
        new ReaderFailed({
          reader: "Spark SQL",
          detail: `the stable name is not a view (${spark.views})`,
        }),
      );

let lake: Lake | undefined;

const environment = Layer.unwrap(
  Effect.gen(function* () {
    const [service, notebook, spark] = yield* Effect.all([
      publish(8000),
      publish(8000),
      publish(8000),
    ]);
    servicePort = service.port;
    notebookPort = notebook.port;
    sparkPort = spark.port;
    const started = yield* startLake({
      label: "Lake",
      file: import.meta.url,
      extra: consumerContainers({ service, notebook, spark }),
    });
    lake = started.lake;
    yield* waitFor("the FastAPI service", httpOk(at(servicePort, "/health")));
    yield* waitFor("the notebook", httpOk(at(notebookPort, "/health")));
    yield* waitFor("the Spark session", httpOk(at(sparkPort, "/health")));
    return exportLayer(lake);
  }),
);

exportSuite(
  environment,
  "Domain Export consumers (Python and Spark over the Iceberg lake)",
  (it) => {
    it.effect(
      "every reader agrees with the model after every step, through retries, rebuilds and promotions",
      () =>
        Arbitrary.checkEffect(
          ops,
          (sequence) =>
            Effect.gen(function* () {
              const store = yield* Iceberg.store({ namespace });
              const table = fresh();
              yield* applySequence(store, table, sequence, (model, step) =>
                Effect.gen(function* () {
                  const expected = want(model);
                  const answers = yield* askAll(table, false);
                  const label = (reader: string) =>
                    `${reader} after step ${step} of ${JSON.stringify(sequence)}`;
                  yield* agree(
                    label("Spark SQL"),
                    yield* sparkRead(answers["Spark SQL"]),
                    expected,
                  );
                  for (const reader of ["FastAPI", "pandas", "Polars", "DuckDB Python"] as const)
                    yield* agree(label(reader), answers[reader], expected);
                }),
              );
              return true;
            }).pipe(Effect.provide(RuntimeContext.phantom)),
          { runs: runsOr(2), maxShrinks: dockerShrinks, seed: "export-consumers" },
        ).pipe(
          Effect.flatMap((result) =>
            result._tag === "Passed"
              ? Effect.void
              : Effect.fail(new Error(Arbitrary.formatCheckFailure(result))),
          ),
        ),
      { ...tags, timeout: testTimeout },
    );

    it.effect(
      "readers racing the writer see only states the lake passed through",
      () =>
        Arbitrary.checkEffect(
          raceOps,
          (sequence) =>
            Effect.gen(function* () {
              const store = yield* Iceberg.store({ namespace });
              const table = fresh();
              // Two readers at once, each asking all five consumers concurrently.
              const { states, reads } = yield* race({
                store,
                name: table,
                sequence,
                read: askAll(table, true),
              });
              for (const { start, end, value: answers } of reads) {
                const allowed = answersDuring(states, start, end, want);
                const spark = yield* sparkRead(answers["Spark SQL"]);
                for (const [name, got] of [
                  ["Spark SQL", spark],
                  ["FastAPI", answers.FastAPI],
                  ["pandas", answers.pandas],
                  ["Polars", answers.Polars],
                  ["DuckDB Python", answers["DuckDB Python"]],
                ] as const) {
                  if (!allowed.has(JSON.stringify(got)))
                    return yield* Effect.fail(
                      new ReaderFailed({
                        reader: name,
                        detail: `read during states ${start}..${end} of ${JSON.stringify(sequence)} saw ${JSON.stringify(got)}; the lake was only ever ${[...allowed].join(" | ")}`,
                      }),
                    );
                }
              }
              // A read that began before a step and ended after it: without one, nothing raced.
              const straddled = reads.filter(({ start, end }) => end > start).length;
              expect(straddled, `reads spanning a step (of ${reads.length})`).toBeGreaterThan(0);
              return true;
            }).pipe(Effect.provide(RuntimeContext.phantom)),
          { runs: runsOr(2), maxShrinks: dockerShrinks, seed: "export-consumers-race" },
        ).pipe(
          Effect.flatMap((result) =>
            result._tag === "Passed"
              ? Effect.void
              : Effect.fail(new Error(Arbitrary.formatCheckFailure(result))),
          ),
        ),
      { ...tags, timeout: testTimeout },
    );
  },
);
