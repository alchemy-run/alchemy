import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Node from "@distilled.cloud/celld/node";
import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import { Artifacts, makeScopedArtifacts } from "@/Artifacts.ts";
import {
  publishApplication,
  readPublicationReceipt,
} from "@/Celld/Deployment.ts";
import { FleetStorage } from "@/Celld/FleetStorage.ts";
import { Namespace, NamespaceProvider } from "@/Celld/KV/Namespace.ts";
import { Queue, QueueProvider } from "@/Celld/Queues/Queue.ts";
import { readStagedDeployment } from "@/Celld/StagedDeployment.ts";
import {
  CelldWorkerProvider,
  Worker,
  type CelldWorker,
} from "@/Celld/Worker.ts";
import { SqlMigrations } from "@/Celld/SqlMigrations.ts";
import { Resource } from "@/Resource.ts";
import {
  makeWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import { sqlObjectExport } from "./fixtures/native-features/sql-object.ts";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { InstanceId } from "@/InstanceId.ts";
import { noopSession } from "@/Report.ts";
import { sanitizeKey } from "@/RuntimeContext.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { beforeAll, describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import { bucketName, prepare } from "./fixtures/native-features/prepare.ts";
import { reportExport } from "./fixtures/native-features/worker.ts";

const nodeUrl = process.env.CELLD_NATIVE_NODE_URL;
const workerUrl = process.env.CELLD_NATIVE_WORKER_URL;
const storageUrl = process.env.CELLD_NATIVE_STORAGE_URL;
const enabled = !!nodeUrl && !!workerUrl && !!storageUrl;
const instanceId = "abcdef0123456789abcdef0123456789";
const owner = {
  stack: "CelldNativeFeatures",
  stage: "test",
  fqn: "Application",
  instanceId,
};
const services = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Layer.succeed(Endpoint, nodeUrl ?? "http://127.0.0.1:1"),
);

const Observation = Schema.NullOr(
  Schema.Struct({
    attempts: Schema.optional(Schema.Number),
    messageId: Schema.optional(Schema.String),
    body: Schema.optional(
      Schema.Struct({
        id: Schema.String,
        mode: Schema.optional(Schema.String),
      }),
    ),
    cron: Schema.optional(Schema.String),
    scheduledTime: Schema.optional(Schema.Number),
  }),
);
const Status = Schema.Struct({
  status: Schema.String,
  output: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      attempt: Schema.Number,
      approved: Schema.Boolean,
      lifecycle: Schema.optional(
        Schema.Struct({
          entries: Schema.Array(Schema.String),
          executed: Schema.Boolean,
          caught: Schema.Boolean,
          sameError: Schema.Boolean,
          terminal: Schema.Boolean,
        }),
      ),
    }),
  ),
});
const get = (path: string) =>
  HttpClient.HttpClient.use((http) => http.get(`${workerUrl}${path}`));
const json = (path: string) =>
  Effect.gen(function* () {
    const response = yield* get(path);
    const body = yield* response.json;
    expect({ status: response.status, body }).toMatchObject({ status: 200 });
    return body;
  });
const post = (path: string, body: unknown = {}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.post(`${workerUrl}${path}`, {
      body: HttpBody.jsonUnsafe(body),
    });
    const text = yield* response.text;
    expect({ status: response.status, body: text }).toMatchObject({
      status: path.startsWith("/queue/") ? 202 : 200,
    });
    return yield* Effect.sync(() =>
      text === "queued" ? text : JSON.parse(text),
    );
  });
const observation = (key: string) =>
  json(`/observe/${encodeURIComponent(key)}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Observation)),
  );
const waitObservation = (key: string) =>
  observation(key).pipe(
    Effect.repeat({
      until: (value) => value !== null,
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
  );
const status = (id: string) =>
  json(`/workflow/status/${id}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Status)),
  );
const waitStatus = (id: string, expected: string) =>
  status(id).pipe(
    Effect.repeat({
      until: (value) => value.status === expected || value.status === "errored",
      schedule: Schedule.spaced("500 millis"),
      times: 10,
    }),
  );
const SqlState = Schema.Struct({
  id: Schema.String,
  tag: Schema.Literal("Cloudflare.SqlMigrations"),
  table: Schema.Literal("native_sql_history"),
  captured: Schema.Array(
    Schema.Struct({ name: Schema.String, hash: Schema.String }),
  ),
  applicationError: Schema.NullOr(Schema.String),
  history: Schema.Array(
    Schema.Struct({ name: Schema.String, hash: Schema.String }),
  ),
  rows: Schema.Array(Schema.Struct({ value: Schema.String })),
  tables: Schema.Array(Schema.Struct({ name: Schema.String })),
});
interface SqlPublication {
  readonly version: string;
  readonly workerName: string;
  readonly durableObjectClasses: Readonly<Record<string, string>>;
  readonly captured: ReadonlyArray<{ name: string; hash: string }>;
}
let publishSql:
  | ((dir: string) => Effect.Effect<SqlPublication, unknown>)
  | undefined;
let runId = "";
let publishedAt = 0;
let publishedVersion = "";

// Retain the dedicated fixture bucket, daemon, observations and ownership records.
describe.skipIf(!enabled)(
  "Celld 0.5 native features over API-only publication",
  () => {
    beforeAll(
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            for (const url of [nodeUrl, workerUrl, storageUrl])
              if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? ""))
                return yield* Effect.fail(
                  new Error("Only isolated loopback fixtures are allowed."),
                );
            runId = yield* Effect.sync(() => crypto.randomUUID());
            const store = yield* prepare(storageUrl!);
            const connection = {
              fleetId: "NativeFeaturesFleet",
              fleetUrl: workerUrl!,
              bucket: {
                uri: `s3://${bucketName}`,
                endpoint: storageUrl!,
                region: "us-east-1",
              },
              hostState: undefined,
            };
            const entries = yield* Effect.sync(() => ({
              service: new URL(
                "./fixtures/native-features/service.ts",
                import.meta.url,
              ).href,
              root: new URL(
                "./fixtures/native-features/worker.ts",
                import.meta.url,
              ).href,
            }));
            const artifacts = yield* Effect.sync(() =>
              makeScopedArtifacts(new Map(), "NativeService"),
            );
            const context = Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(FleetStorage, () => Effect.succeed(store)),
              Layer.succeed(Artifacts, artifacts),
              Layer.succeed(Stack, {
                name: owner.stack,
                stage: owner.stage,
                resources: {},
                bindings: {},
                actions: {},
              }),
              Layer.succeed(Stage, owner.stage),
              Layer.succeed(InstanceId, instanceId),
            );
            const providers = Layer.mergeAll(
              CelldWorkerProvider(),
              NamespaceProvider(),
              QueueProvider(),
            ).pipe(Layer.provideMerge(context));
            const staged = yield* Effect.gen(function* () {
              const input = {
                instanceId,
                session: {
                  ...noopSession,
                  note: (message: string) => Effect.log(message),
                },
                bindings: [],
                olds: undefined,
                output: undefined,
              };
              const kv = yield* (yield* Namespace.Provider).reconcile({
                ...input,
                id: "OBSERVATIONS",
                fqn: "OBSERVATIONS",
                news: { ...connection, title: "Native feature observations" },
              });
              const jobs = yield* (yield* Queue.Provider).reconcile({
                ...input,
                id: "JOBS",
                fqn: "JOBS",
                news: { ...connection, name: "native-jobs" },
              });
              const dead = yield* (yield* Queue.Provider).reconcile({
                ...input,
                id: "DEAD",
                fqn: "DEAD",
                news: { ...connection, name: "native-dead" },
              });
              const provider = yield* Worker.Provider;
              const jobsRef = yield* Queue.ref("JOBS");
              const deadRef = yield* Queue.ref("DEAD");
              // Direct lifecycle calls supply the output environment normally collected at init.
              const queueEnv = yield* Effect.sync(() => ({
                [sanitizeKey(jobsRef.queueName.toString())]: jobs.queueName,
                [sanitizeKey(deadRef.queueName.toString())]: dead.queueName,
              }));
              const common = {
                ...connection,
                celldVersion: "0.5.0",
                fleetSecret: Redacted.make("native-features-gateway-secret"),
                compatibilityDate: "2026-09-01",
                compatibilityFlags: ["nodejs_compat"],
              };
              const service = yield* provider.reconcile({
                ...input,
                id: "NativeService",
                fqn: "NativeService",
                news: {
                  ...common,
                  main: entries.service,
                },
              });
              const rootArtifacts = yield* Effect.sync(() =>
                makeScopedArtifacts(new Map(), "NativeFeatures"),
              );
              const rootInput: Parameters<typeof provider.reconcile>[0] = {
                ...input,
                id: "NativeFeatures",
                fqn: "NativeFeatures",
                bindings: [
                  {
                    sid: "native-events",
                    data: {
                      crons: ["* * * * *"],
                      queueConsumers: [
                        {
                          queue: jobs.queueName,
                          maxBatchSize: 1,
                          maxBatchTimeout: 0,
                          maxRetries: 1,
                          retryDelay: 1,
                          deadLetterQueue: dead.queueName,
                        },
                        {
                          queue: dead.queueName,
                          maxBatchSize: 1,
                          maxBatchTimeout: 0,
                          maxRetries: 1,
                        },
                      ],
                    },
                  },
                ],
                news: {
                  ...common,
                  main: entries.root,
                  exports: { NativeReports: reportExport },
                  env: queueEnv,
                  assets: {
                    directory: "public",
                    binding: "ASSETS",
                    runWorkerFirst: true,
                  },
                  bindings: [
                    {
                      type: "kv_namespace",
                      name: "OBSERVATIONS",
                      namespaceId: kv.namespaceId,
                    },
                    {
                      type: "queue",
                      name: "JOBS",
                      queueName: jobs.queueName,
                    },
                    {
                      type: "queue",
                      name: "DEAD",
                      queueName: dead.queueName,
                    },
                    {
                      type: "workflow",
                      name: "NativeReports",
                      workflowName: "NativeReports",
                      className: "NativeReports",
                    },
                    {
                      type: "service",
                      name: "SERVICE",
                      service: service.workerName,
                    },
                    { type: "worker_loader", name: "LOADER" },
                  ],
                },
              };
              const root = yield* provider
                .reconcile(rootInput)
                .pipe(Effect.provide(Layer.succeed(Artifacts, rootArtifacts)));
              return { root, service, rootInput };
            }).pipe(Effect.provide(providers));
            const root = yield* readStagedDeployment(
              store,
              staged.root.stagedManifestKey,
            );
            const service = yield* readStagedDeployment(
              store,
              staged.service.stagedManifestKey,
            );
            const previous = yield* readPublicationReceipt(store);
            publishedAt = yield* Effect.sync(() => Date.now());
            publishedVersion = root.version;
            const publication = yield* publishApplication(store, {
              rootPreparedDeployment: root,
              workers: [service],
              owner,
              transactionId: `native-${root.version}-${previous?.revision.slice(0, 16) ?? "initial"}`,
              priorRevision: previous?.revision,
            });
            expect((yield* Node.reloadDeployment({})).ok).toBe(true);
            const state = yield* Node.getNodeState({}).pipe(
              Effect.repeat({
                until: (value) => value.deployment?.version === root.version,
                schedule: Schedule.spaced("500 millis"),
                times: 8,
              }),
            );
            expect(state.deployment?.version).toBe(root.version);
            let currentProps = staged.rootInput.news;
            let currentOutput = staged.root;
            publishSql = (dir) =>
              Effect.gen(function* () {
                const host = makeWorkerRuntimeContext("native-sql-capture");
                const Host = Context.Service<CelldWorker, WorkerRuntimeContext>(
                  Resource<CelldWorker>("Celld.Worker").Self.key,
                );
                const captured = yield* SqlMigrations({
                  dir,
                  table: "native_sql_history",
                }).pipe(Effect.provideService(Host, host));
                const { default: _default, ...migrationExports } =
                  yield* host.exports;
                const news = {
                  ...staged.rootInput.news,
                  env: {
                    ...staged.rootInput.news.env,
                    NATIVE_SQL_DIRECTORY: dir,
                  },
                  exports: {
                    ...staged.rootInput.news.exports,
                    NativeSqlObject: sqlObjectExport,
                    ...migrationExports,
                  },
                };
                const artifacts = yield* Effect.sync(() =>
                  makeScopedArtifacts(new Map(), "NativeSqlUpdate"),
                );
                const updated = yield* (yield* Worker.Provider)
                  .reconcile({
                    ...staged.rootInput,
                    news,
                    olds: currentProps,
                    output: currentOutput,
                    bindings: [
                      ...staged.rootInput.bindings,
                      {
                        sid: "native-sql",
                        data: {
                          durableObjects: [
                            {
                              name: "NativeSqlObject",
                              className: "NativeSqlObject",
                            },
                          ],
                        },
                      },
                    ],
                  })
                  .pipe(Effect.provide(Layer.succeed(Artifacts, artifacts)));
                const prepared = yield* readStagedDeployment(
                  store,
                  updated.stagedManifestKey,
                );
                const previous = yield* readPublicationReceipt(store);
                const publication = yield* publishApplication(store, {
                  rootPreparedDeployment: prepared,
                  workers: [service],
                  owner,
                  transactionId: `native-sql-${prepared.version}-${previous?.revision.slice(0, 16) ?? "initial"}`,
                  priorRevision: previous?.revision,
                });
                expect((yield* Node.reloadDeployment({})).ok).toBe(true);
                const active = yield* Node.getNodeState({}).pipe(
                  Effect.repeat({
                    until: (value) =>
                      value.deployment?.version === prepared.version,
                    schedule: Schedule.spaced("500 millis"),
                    times: 8,
                  }),
                );
                expect(active.deployment?.version).toBe(prepared.version);
                currentProps = news;
                currentOutput = updated;
                yield* Effect.log({
                  sqlVersion: prepared.version,
                  revision: publication.revision,
                });
                return {
                  version: prepared.version,
                  workerName: updated.workerName,
                  durableObjectClasses: updated.durableObjectClasses,
                  captured: captured.records.map(({ name, hash }) => ({
                    name,
                    hash,
                  })),
                };
              }).pipe(
                Effect.scoped,
                Effect.provide(Layer.mergeAll(providers, services)),
              );
            yield* Effect.log({
              bucketName,
              workerUrl,
              nodeUrl,
              version: root.version,
              revision: publication.revision,
              runId,
            });
          }).pipe(Effect.provide(services), Effect.timeout("85 seconds")),
        ),
      90_000,
    );

    test.live(
      "adopts the published root and serves the bundled Effect worker",
      () =>
        Effect.gen(function* () {
          expect((yield* Node.getNodeState({})).deployment?.version).toBe(
            publishedVersion,
          );
          expect(yield* json("/health")).toEqual({
            runtime: "celld",
            fixture: "native-features",
          });
        }).pipe(Effect.provide(services)),
    );

    test.live(
      "queue send and sendBatch reach the real push consumer",
      () =>
        Effect.gen(function* () {
          const ids = [
            `single-${runId}`,
            `batch-a-${runId}`,
            `batch-b-${runId}`,
          ];
          yield* post("/queue/send", [{ id: ids[0] }]);
          yield* post(
            "/queue/batch",
            ids.slice(1).map((id) => ({ id })),
          );
          for (const id of ids) {
            const value = yield* waitObservation(`queue:${id}`);
            expect(value).toMatchObject({ body: { id }, attempts: 1 });
            expect(value?.messageId).toBeTruthy();
          }
        }).pipe(Effect.provide(services)),
      { timeout: 90_000 },
    );

    test.live(
      "queue retry redelivers and exhausted messages reach the dead-letter consumer",
      () =>
        Effect.gen(function* () {
          const retry = `retry-${runId}`;
          const dead = `dead-${runId}`;
          yield* post("/queue/batch", [
            { id: retry, mode: "retry" },
            { id: dead, mode: "dead" },
          ]);
          expect(yield* waitObservation(`queue:${retry}`)).toMatchObject({
            body: { id: retry },
            attempts: 2,
          });
          expect(yield* waitObservation(`dead:${dead}`)).toMatchObject({
            body: { id: dead, mode: "dead" },
          });
          expect(yield* observation(`queue:${dead}`)).toBeNull();
        }).pipe(Effect.provide(services)),
      { timeout: 90_000 },
    );

    test.live(
      "workflow task, sleep, pause/resume, event, completion and restart run natively",
      () =>
        Effect.gen(function* () {
          const id = `workflow-${runId}`;
          expect(yield* post("/workflow/create", { id, wait: true })).toEqual({
            id,
          });
          expect((yield* waitStatus(id, "waiting")).status).toBe("waiting");
          yield* post(`/workflow/pause/${id}`);
          expect((yield* waitStatus(id, "paused")).status).toBe("paused");
          yield* post(`/workflow/resume/${id}`);
          yield* post(`/workflow/event/${id}`);
          expect(yield* waitStatus(id, "complete")).toMatchObject({
            status: "complete",
            output: { id, attempt: 1, approved: true },
          });
          yield* post(`/workflow/restart/${id}`);
          yield* post(`/workflow/event/${id}`);
          expect((yield* waitStatus(id, "complete")).status).toBe("complete");
        }).pipe(Effect.provide(services)),
      { timeout: 90_000 },
    );

    for (const scenario of [
      "retry",
      "exhaustion",
      "die",
      "interrupt",
      "replay",
    ] as const) {
      test.live(
        `workflow ${scenario} owns attempt resources and preserves native failures`,
        () =>
          Effect.gen(function* () {
            const id = `workflow-${scenario}-${runId}`;
            yield* post("/workflow/create", { id, lifecycle: scenario });
            const completed = yield* waitStatus(id, "complete");
            expect(completed.status).toBe("complete");
            const lifecycle = completed.output?.lifecycle;
            const retry = ["retry", "exhaustion", "replay"].includes(scenario);
            expect(lifecycle).toMatchObject({
              executed: true,
              caught: scenario === "exhaustion" || scenario === "replay",
              sameError: scenario === "exhaustion" || scenario === "replay",
              terminal: scenario === "die",
            });
            expect(lifecycle?.entries).toEqual([
              "open:1",
              "close:1",
              ...(retry
                ? ["delay:1", "delay-close:1", "open:2", "close:2"]
                : []),
              ...(scenario === "interrupt" ? ["joined"] : []),
            ]);
            if (scenario === "replay") {
              yield* post(`/workflow/restart/${id}?checkpoint`);
              const replayed = yield* status(id).pipe(
                Effect.repeat({
                  until: (value) =>
                    value.output?.lifecycle?.executed === false ||
                    value.status === "errored",
                  schedule: Schedule.spaced("500 millis"),
                  times: 10,
                }),
              );
              expect(replayed).toMatchObject({
                status: "complete",
                output: {
                  lifecycle: {
                    entries: lifecycle?.entries,
                    executed: false,
                    caught: true,
                    sameError: false,
                    terminal: false,
                  },
                },
              });
            }
            yield* post(`/workflow/delete/${id}`);
          }).pipe(Effect.provide(services)),
        { timeout: 60_000 },
      );
    }

    test.live(
      "workflow batch creation, termination and explicit history deletion run natively",
      () =>
        Effect.gen(function* () {
          const ids = [`terminate-a-${runId}`, `terminate-b-${runId}`];
          expect(
            yield* post(
              "/workflow/batch",
              ids.map((id) => ({ id, wait: true })),
            ),
          ).toEqual(ids);
          for (const id of ids) {
            yield* post(`/workflow/terminate/${id}`);
            expect((yield* waitStatus(id, "terminated")).status).toBe(
              "terminated",
            );
          }
          yield* post(`/workflow/delete/${ids[0]}`);
          const missing = yield* get(`/workflow/status/${ids[0]}`);
          expect(missing.status).toBe(500);
          expect(yield* missing.text).toContain(
            "WORKFLOW_ERROR: instance does not exist",
          );
          expect(
            yield* post("/workflow/deleteBatch", [ids[1], `missing-${runId}`]),
          ).toMatchObject({
            deleted: [{ id: ids[1] }],
            errors: [{ id: `missing-${runId}`, code: 10400 }],
          });
        }).pipe(Effect.provide(services)),
      { timeout: 90_000 },
    );

    test.live(
      "actual minute cron invokes the scheduled Effect handler",
      () =>
        Effect.gen(function* () {
          const value = yield* observation("cron:last").pipe(
            Effect.repeat({
              until: (event) => (event?.scheduledTime ?? 0) >= publishedAt,
              schedule: Schedule.spaced("7 seconds"),
              times: 10,
            }),
          );
          expect(value?.cron).toBe("* * * * *");
          expect(value?.scheduledTime).toBeGreaterThanOrEqual(publishedAt);
        }).pipe(Effect.provide(services)),
      { timeout: 90_000 },
    );

    test.live(
      "native asset binding serves bytes, headers, redirect and missing status",
      () =>
        Effect.gen(function* () {
          const asset = yield* get("/hello.txt");
          expect(asset.status).toBe(200);
          expect(yield* asset.text).toBe("Celld native asset fixture.\n");
          expect(asset.headers["x-native-asset"]).toBe("yes");
          const redirect = yield* get("/old");
          expect(redirect.status).toBe(302);
          expect(redirect.headers.location).toBe("/hello.txt");
          expect((yield* get("/missing.txt")).status).toBe(404);
        }).pipe(Effect.provide(services)),
    );

    test.live(
      "native service fetch forwards method, body and response headers to another bundled worker",
      () =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient;
          const response = yield* http.post(`${workerUrl}/service`, {
            body: HttpBody.text("native-service-body"),
            headers: { "x-native-token": runId },
          });
          expect(response.status).toBe(200);
          expect(response.headers["x-native-service"]).toBe("yes");
          expect(yield* response.json).toEqual({
            service: "native-service",
            method: "POST",
            body: "native-service-body",
            token: runId,
          });
        }).pipe(Effect.provide(services)),
    );

    test.live(
      "native loader supports scoped anonymous fetch, named reuse and direct RPC with props",
      () =>
        Effect.gen(function* () {
          for (const path of [
            "/loader/anonymous",
            "/loader/named",
            "/loader/named",
          ])
            expect(yield* json(path)).toEqual({
              body: { loaded: true, marker: "native-loader", method: "GET" },
              sum: 9,
            });
        }).pipe(Effect.provide(services)),
    );

    test.live(
      "captured SQL migrates native cells atomically and SQL-only publications retain identity and user data",
      () =>
        Effect.gen(function* () {
          if (!publishSql)
            return yield* Effect.die(
              "Native SQL publisher was not initialized",
            );
          const publish = publishSql;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "celld-native-sql-",
          });
          const firstName = "0001_items.sql";
          const secondName = "0002_committed.sql";
          const thirdName = "0003_repaired.sql";
          yield* fs.writeFileString(
            path.join(dir, firstName),
            "CREATE TABLE items (value TEXT NOT NULL);\n--> statement-breakpoint\nINSERT INTO items VALUES ('seed');",
          );
          const initialPublication = yield* publish(dir);
          const name = `migrations-${runId}`;
          const read = (name: string) =>
            json(`/sql/${name}`).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(SqlState)),
            );
          const initial = yield* read(name);
          expect(initial.id).toBeTruthy();
          expect(initial.applicationError).toBeNull();
          expect(initial.captured).toEqual(initialPublication.captured);
          expect(initial.history).toEqual(initialPublication.captured);
          expect(initial.history[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
          expect(initial.rows).toEqual([{ value: "seed" }]);
          expect(initial.tables).toEqual([]);
          yield* post(`/sql/${name}`);

          yield* fs.writeFileString(
            path.join(dir, secondName),
            "INSERT INTO items VALUES ('migration-two');",
          );
          yield* fs.writeFileString(
            path.join(dir, thirdName),
            "CREATE TABLE rolled_back (value TEXT);\n--> statement-breakpoint\nINSERT INTO items VALUES ('must-rollback');\n--> statement-breakpoint\nINSERT INTO missing_table VALUES (1);",
          );
          const brokenPublication = yield* publish(dir);
          expect(brokenPublication.version).not.toBe(
            initialPublication.version,
          );
          expect(brokenPublication.workerName).toBe(
            initialPublication.workerName,
          );
          expect(brokenPublication.durableObjectClasses).toEqual(
            initialPublication.durableObjectClasses,
          );
          const broken = yield* read(name);
          expect(broken.id).toBe(initial.id);
          expect(broken.captured).toEqual(brokenPublication.captured);
          expect(broken.applicationError).toBe("MigrationError");
          expect(broken.history).toEqual(
            brokenPublication.captured.slice(0, 2),
          );
          expect(broken.rows).toEqual([
            { value: "seed" },
            { value: "user-data" },
            { value: "migration-two" },
          ]);
          expect(broken.tables).toEqual([]);

          yield* fs.writeFileString(
            path.join(dir, thirdName),
            "INSERT INTO items VALUES ('migration-three');",
          );
          const repairedPublication = yield* publish(dir);
          expect(repairedPublication.version).not.toBe(
            brokenPublication.version,
          );
          expect(repairedPublication.workerName).toBe(
            initialPublication.workerName,
          );
          expect(repairedPublication.durableObjectClasses).toEqual(
            initialPublication.durableObjectClasses,
          );
          expect(repairedPublication.captured[2]?.hash).not.toBe(
            brokenPublication.captured[2]?.hash,
          );
          const repaired = yield* read(name);
          expect(repaired.id).toBe(initial.id);
          expect(repaired.applicationError).toBeNull();
          expect(repaired.captured).toEqual(repairedPublication.captured);
          expect(repaired.history).toEqual(repairedPublication.captured);
          expect(repaired.rows).toEqual([
            { value: "seed" },
            { value: "user-data" },
            { value: "migration-two" },
            { value: "migration-three" },
          ]);
          expect(repaired.tables).toEqual([]);
          expect(yield* json(`/sql/${name}?reapply`)).toEqual(repaired);
          const isolated = yield* read(`${name}-isolated`);
          expect(isolated.id).not.toBe(initial.id);
          expect(isolated.history).toEqual(repaired.history);
          expect(isolated.rows).toEqual([
            { value: "seed" },
            { value: "migration-two" },
            { value: "migration-three" },
          ]);
          yield* Effect.log({
            nativeSqlProof: {
              id: initial.id,
              workerName: initialPublication.workerName,
              versions: [
                initialPublication.version,
                brokenPublication.version,
                repairedPublication.version,
              ],
              history: repaired.history,
              rows: repaired.rows,
              rollbackTables: broken.tables,
            },
          });
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 90_000 },
    );
  },
);
