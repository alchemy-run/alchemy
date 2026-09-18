import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Node from "@distilled.cloud/celld/node";
import * as Runtime from "@distilled.cloud/celld/runtime";
import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import { expect, test } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { reconcileApplication } from "@/Celld/Application.ts";
import { ensureBootstrap, prepareBootstrap } from "@/Celld/Bootstrap.ts";
import {
  APPLICATION_LOCK_KEY,
  prepareDeployment,
  publishApplication,
  readPublicationReceipt,
  stageDeployment,
} from "@/Celld/Deployment.ts";
import { digest, encode } from "@/Celld/Deployment/Objects.ts";
import {
  discoverManagementNodes,
  FleetManagement,
  makeLocalFleetManagement,
} from "@/Celld/Management.ts";
import { ManagementBindings } from "@/Celld/ManagementBindings.ts";
import { activationOwner } from "../fixtures/activation-live.ts";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { createHash } from "node:crypto";
import {
  applyD1MigrationRecords,
  migrationLockKey,
} from "@/Celld/D1/ApplyMigrations.ts";
import { Database, DatabaseProvider } from "@/Celld/D1/Database.ts";
import { FleetStorage } from "@/Celld/FleetStorage.ts";
import { makeS3Store } from "@/Celld/FleetStorageS3.ts";
import {
  d1Scope,
  FleetOperator,
  makeLocalFleetOperator,
  OperatorError,
  signOperatorInput,
} from "@/Celld/OperatorClient.ts";
import { readCatalog } from "@/Celld/ResourceCatalog.ts";
import { InstanceId } from "@/InstanceId.ts";
import { noopSession } from "@/Report.ts";
import type { MigrationRecord } from "@/SQL/Migrations/index.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  fixtureBucket,
  fixtureCredentials,
  fixtureNode,
  fixturePeerKey,
} from "../fixtures/prepare-d1-live.ts";

const endpoint = process.env.CELLD_D1_NODE_URL;
const storageEndpoint = process.env.CELLD_D1_STORAGE_URL;
const live = test.skipIf(!endpoint || !storageEndpoint);
const connection = {
  fleetId: "D1LiveFleet",
  fleetUrl: endpoint!,
  bucket: {
    uri: `s3://${fixtureBucket}`,
    endpoint: storageEndpoint,
    region: "us-east-1",
  },
  hostState: undefined,
};
const services = Layer.mergeAll(
  FetchHttpClient.layer,
  NodeServices.layer,
  Layer.succeed(Endpoint, endpoint ?? "http://127.0.0.1:1"),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Endpoint>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(services), Effect.timeout("100 seconds")),
  );
const record = (name: string, sql: string) =>
  Effect.sync((): MigrationRecord => ({
    name,
    sql,
    hash: createHash("sha256").update(sql).digest("hex"),
    createdAtMillis: undefined,
    statements: [sql],
  }));

const fixture = Effect.gen(function* () {
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? "") ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(storageEndpoint ?? "")
  )
    return yield* Effect.fail(
      new Error("Use only the owned loopback fixture."),
    );
  const http = yield* HttpClient.HttpClient;
  const observedHttp = http.pipe(
    HttpClient.tap((response) =>
      response.status >= 400
        ? response.text.pipe(
            Effect.tap((body) =>
              Effect.log({
                operatorStatus: response.status,
                operatorBody: body,
              }),
            ),
            Effect.as(response),
          )
        : Effect.succeed(response),
    ),
  );
  const options = {
    endpoint: endpoint!,
    source: "alchemy-live-test",
    target: fixtureNode,
    peerKey: Redacted.make(
      yield* Effect.sync(
        () => new Uint8Array(Buffer.from(fixturePeerKey, "hex")),
      ),
    ),
    httpClient: observedHttp,
  };
  const store = yield* makeS3Store(connection.bucket, fixtureCredentials, http);
  const operator = makeLocalFleetOperator(options);
  return { options, operator, store };
});

live(
  "live v0.5 generated D1 API, SQL errors, and transactional versus nontransactional execution",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const state = yield* Node.getNodeState({});
        expect(state.deployment?.version).toBeDefined();
        const address = {
          scope: yield* d1Scope("alchemy-d1-live-api"),
          name: "alchemy-d1-live-api",
        };
        const query = yield* f.operator.executeD1Statements(connection, {
          ...address,
          statements: [
            {
              sql: "  SELECT ? AS nullable, ? AS value, ? AS blob; -- exact source\n",
              params: [null, "hello", [1, 2, 255]],
            },
          ],
        });
        expect(query.result[0]?.columns).toEqual(["nullable", "value", "blob"]);
        expect(query.result[0]?.rows).toEqual([[null, "hello", [1, 2, 255]]]);
        expect(query.result[0]?.meta).toBeDefined();
        yield* f.operator.execD1(connection, {
          ...address,
          exec: {
            sql: "DROP TABLE IF EXISTS partial; CREATE TABLE partial(n INTEGER); DROP TABLE IF EXISTS should_rollback; DROP TABLE IF EXISTS failed_native_migrations;",
          },
        });

        const callServices = Layer.mergeAll(
          Layer.succeed(Endpoint, endpoint!),
          Layer.succeed(HttpClient.HttpClient, f.options.httpClient),
        );
        const execError = yield* Runtime.execD1(
          yield* signOperatorInput(f.options, Runtime.ExecD1Input, {
            ...address,
            exec: {
              sql: "SELECT * FROM definitely_missing_live_table;",
              rows: true,
            },
          }),
        ).pipe(Effect.provide(callServices), Effect.result);
        expect(Result.isFailure(execError)).toBe(true);
        if (Result.isFailure(execError)) {
          expect(execError.failure._tag).toBe("D1ExecutionError");
          expect(execError.failure.message).toBe(
            "D1_EXEC_ERROR: no such table: definitely_missing_live_table",
          );
        }
        const statementsError = yield* Runtime.executeD1Statements(
          yield* signOperatorInput(
            f.options,
            Runtime.ExecuteD1StatementsInput,
            {
              ...address,
              statements: [
                { sql: "INSERT INTO partial VALUES (1);" },
                {
                  sql: "INSERT INTO definitely_missing_live_table VALUES (1);",
                },
              ],
            },
          ),
        ).pipe(Effect.provide(callServices), Effect.result);
        expect(Result.isFailure(statementsError)).toBe(true);
        if (Result.isFailure(statementsError)) {
          expect(statementsError.failure._tag).toBe("D1ExecutionError");
          expect(statementsError.failure.message).toBe(
            "D1_ERROR: no such table: definitely_missing_live_table",
          );
        }
        expect(
          (yield* f.operator.executeD1Statements(connection, {
            ...address,
            statements: [{ sql: "SELECT COUNT(*) AS count FROM partial;" }],
          })).result[0]?.rows,
        ).toEqual([[1]]);
        const migrationError = yield* Runtime.migrateD1(
          yield* signOperatorInput(f.options, Runtime.MigrateD1Input, {
            ...address,
            migrate: {
              name: "bad",
              table: "failed_native_migrations",
              sql: "CREATE TABLE should_rollback(n INTEGER); INSERT INTO definitely_missing_live_table VALUES (1);",
            },
          }),
        ).pipe(Effect.provide(callServices), Effect.result);
        expect(Result.isFailure(migrationError)).toBe(true);
        if (Result.isFailure(migrationError)) {
          expect(migrationError.failure._tag).toBe("D1ExecutionError");
          expect(migrationError.failure.message).toBe(
            "D1_ERROR: no such table: definitely_missing_live_table",
          );
        }
        expect(
          (yield* f.operator.executeD1Statements(connection, {
            ...address,
            statements: [
              {
                sql: "SELECT name FROM sqlite_master WHERE name IN ('should_rollback', 'failed_native_migrations');",
              },
            ],
          })).result[0]?.rows,
        ).toEqual([]);

        const signed = yield* signOperatorInput(
          f.options,
          Runtime.ExecuteD1StatementsInput,
          { ...address, statements: [{ sql: "SELECT 1;" }] },
        );
        yield* Runtime.executeD1Statements(signed).pipe(
          Effect.provide(callServices),
        );
        const replay = yield* Runtime.executeD1Statements(signed).pipe(
          Effect.provide(callServices),
          Effect.result,
        );
        expect(Result.isFailure(replay)).toBe(true);
        if (Result.isFailure(replay))
          expect(replay.failure._tag).toBe("PeerReplayRejected");
      }),
    ),
  { timeout: 120_000 },
);

live(
  "live v0.5 Alchemy migrations use S3 conditional locks and recover a lost committed response",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const databaseId = "alchemy-d1-live-registry";
        const address = { scope: yield* d1Scope(databaseId), name: databaseId };
        expect(
          yield* f.store.get(migrationLockKey(databaseId)),
        ).toBeUndefined();
        yield* f.operator.execD1(connection, {
          ...address,
          exec: {
            sql: "DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS __alchemy_migrations; DROP TABLE IF EXISTS __alchemy_d1_transactions; DROP TABLE IF EXISTS __alchemy_d1_precondition;",
          },
        });
        const records = [
          yield* record(
            "0001.sql",
            "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT);",
          ),
          yield* record("0002.sql", "INSERT INTO items VALUES (1, 'live');"),
        ];
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const operator = {
          ...f.operator,
          migrateD1: (
            conn: Parameters<typeof f.operator.migrateD1>[0],
            input: Parameters<typeof f.operator.migrateD1>[1],
          ) =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* f.operator.migrateD1(conn, input);
              return yield* Effect.fail(
                new OperatorError({
                  message:
                    "Simulated lost response after the real node committed.",
                }),
              );
            }),
        };
        const options = {
          connection,
          databaseId,
          table: "__alchemy_migrations",
          records,
          store: f.store,
          operator,
        };
        const first = yield* applyD1MigrationRecords(options).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        expect(
          Result.isFailure(
            yield* applyD1MigrationRecords(options).pipe(Effect.result),
          ),
        ).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        const appliedCalls = calls;
        yield* applyD1MigrationRecords(options);
        expect(calls).toBe(appliedCalls);
        expect(calls).toBe(3);
        expect(
          yield* f.store.get(migrationLockKey(databaseId)),
        ).toBeUndefined();
        expect(
          (yield* f.operator.executeD1Statements(connection, {
            ...address,
            statements: [{ sql: "SELECT id, value FROM items;" }],
          })).result[0]?.rows,
        ).toEqual([[1, "live"]]);
        expect(
          (yield* f.operator.executeD1Statements(connection, {
            ...address,
            statements: [
              {
                sql: "SELECT name, hash FROM __alchemy_migrations ORDER BY id;",
              },
            ],
          })).result[0]?.rows,
        ).toEqual(records.map((record) => [record.name, record.hash]));
        const changed = [
          yield* record("0001.sql", "CREATE TABLE changed(n);"),
          records[1]!,
        ];
        expect(
          Result.isFailure(
            yield* applyD1MigrationRecords({
              ...options,
              records: changed,
            }).pipe(Effect.result),
          ),
        ).toBe(true);
      }),
    ),
  { timeout: 120_000 },
);

live(
  "live v0.5 converts foreign migration history without rewriting the foreign ledger",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const databaseId = "alchemy-d1-live-foreign";
        const address = { scope: yield* d1Scope(databaseId), name: databaseId };
        expect(
          yield* f.store.get(migrationLockKey(databaseId)),
        ).toBeUndefined();
        yield* f.operator.execD1(connection, {
          ...address,
          exec: {
            sql: "DROP TABLE IF EXISTS foreign_items; DROP TABLE IF EXISTS d1_migrations; DROP TABLE IF EXISTS __alchemy_migrations; DROP TABLE IF EXISTS __alchemy_d1_transactions; DROP TABLE IF EXISTS __alchemy_d1_precondition; CREATE TABLE foreign_items(value TEXT); CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO d1_migrations VALUES (1, '0001.sql', '2026-09-18');",
          },
        });
        const records = [
          yield* record("0001.sql", "CREATE TABLE foreign_items(value TEXT);"),
          yield* record(
            "0002.sql",
            "INSERT INTO foreign_items VALUES ('converted');",
          ),
        ];
        yield* applyD1MigrationRecords({
          connection,
          databaseId,
          table: "__alchemy_migrations",
          records,
          store: f.store,
          operator: f.operator,
        });
        expect(
          (yield* f.operator.executeD1Statements(connection, {
            ...address,
            statements: [
              { sql: "SELECT name, applied_at FROM d1_migrations;" },
            ],
          })).result[0]?.rows,
        ).toEqual([["0001.sql", "2026-09-18"]]);
        expect(
          (yield* f.operator.executeD1Statements(connection, {
            ...address,
            statements: [
              {
                sql: "SELECT name, hash FROM __alchemy_migrations ORDER BY id;",
              },
            ],
          })).result[0]?.rows,
        ).toEqual(records.map((record) => [record.name, record.hash]));
        expect(
          (yield* f.operator.executeD1Statements(connection, {
            ...address,
            statements: [{ sql: "SELECT value FROM foreign_items;" }],
          })).result[0]?.rows,
        ).toEqual([["converted"]]);
        expect(
          yield* f.store.get(migrationLockKey(databaseId)),
        ).toBeUndefined();
      }),
    ),
  { timeout: 120_000 },
);

live(
  "live v0.5 bootstrap D1 survives a binding-free Application with data and ownership retained",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const bootstrapProps = {
          bucket: connection.bucket,
          runtimeVersion: "0.5.0",
        };
        yield* ensureBootstrap(f.store, bootstrapProps);
        const bootstrap = yield* prepareBootstrap(bootstrapProps);
        const previous = yield* readPublicationReceipt(f.store);
        if (previous) expect(previous.owner).toEqual(activationOwner);
        expect(yield* f.store.get(APPLICATION_LOCK_KEY)).toBeUndefined();
        // Reuse the fixture owner and normal publisher; never reset native storage or the lock.
        yield* publishApplication(
          f.store,
          {
            rootPreparedDeployment: bootstrap,
            workers: [],
            owner: activationOwner,
            transactionId: yield* digest(
              yield* encode({
                bootstrap: bootstrap.version,
                priorRevision: previous?.revision ?? null,
              }),
            ),
            priorRevision: previous?.revision,
          },
          () =>
            Effect.gen(function* () {
              expect(yield* f.store.get(APPLICATION_LOCK_KEY)).toBeDefined();
              expect((yield* Node.reloadDeployment({})).ok).toBe(true);
              const state = yield* Node.getNodeState({}).pipe(
                Effect.repeat({
                  until: (state) =>
                    state.deployment?.version === bootstrap.version &&
                    state.deployment.swapping === 0,
                  schedule: Schedule.spaced("500 millis"),
                  times: 8,
                }),
              );
              expect(state.deployment?.version).toBe(bootstrap.version);
              expect(state.deployment?.swapping).toBe(0);
            }),
        );
        const instanceId = "d1live0123456789abcdef012345678901";
        const layer = DatabaseProvider().pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              services,
              Layer.succeed(FleetStorage, () => Effect.succeed(f.store)),
              Layer.succeed(FleetOperator, f.operator),
              Layer.succeed(Stack, {
                name: "D1Live",
                stage: "test",
                resources: {},
                bindings: {},
                actions: {},
              }),
              Layer.succeed(Stage, "test"),
              Layer.succeed(InstanceId, instanceId),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const provider = yield* Database.Provider;
          const input = {
            id: "Db",
            fqn: "Db",
            instanceId,
            session: { ...noopSession, note: () => Effect.void },
            bindings: [],
            olds: undefined,
            output: undefined,
          };
          const news = { ...connection, name: "alchemy-d1-live-resource" };
          const output = yield* provider.reconcile({ ...input, news });
          const address = {
            scope: yield* d1Scope(output.databaseId),
            name: output.databaseId,
          };
          yield* f.operator.execD1(connection, {
            ...address,
            exec: {
              sql: "CREATE TABLE IF NOT EXISTS retained(id INTEGER PRIMARY KEY, value TEXT); INSERT OR REPLACE INTO retained VALUES (1, 'retained');",
            },
          });
          const catalog = yield* readCatalog(
            connection,
            "d1",
            output.databaseId,
          );
          expect(catalog?.owner).toEqual({
            stack: "D1Live",
            stage: "test",
            fqn: "Db",
            instanceId,
          });
          const readRetained = f.operator.executeD1Statements(connection, {
            ...address,
            statements: [{ sql: "SELECT value FROM retained WHERE id = 1;" }],
          });
          expect((yield* readRetained).result[0]?.rows).toEqual([["retained"]]);
          const source = yield* prepareDeployment({
            scriptName: "d1-unbound-application",
            mainModule: "index.js",
            modules: [
              {
                name: "index.js",
                content:
                  "export default { fetch() { return new Response('unbound'); } };",
              },
            ],
            metadata: {
              main_module: "index.js",
              compatibility_date: "2026-09-01",
              bindings: [],
            },
            doClasses: [],
            sqliteClasses: [],
          });
          expect(source.manifest.do_classes).toEqual([]);
          yield* stageDeployment(f.store, source);
          const http = yield* HttpClient.HttpClient;
          const nodes = yield* discoverManagementNodes(f.store, {
            minimumNodes: 1,
            maximumNodes: 1,
          });
          const native = http.pipe(
            HttpClient.mapRequest((request) =>
              request.url.startsWith(`${nodes[0]!.endpoint}/`)
                ? HttpClientRequest.setUrl(
                    request,
                    request.url.replace(nodes[0]!.endpoint, endpoint!),
                  )
                : request,
            ),
          );
          const management = makeLocalFleetManagement(
            () => Effect.succeed(f.store),
            native,
            { minimumNodes: 1, maximumNodes: 1 },
          );
          const member = (deployment: typeof source) => ({
            workerName: deployment.scriptName,
            fleetId: connection.fleetId,
            stagedManifestKey: deployment.candidate.key,
            exposed: false,
            url: connection.fleetUrl,
          });
          const publish = (workers: readonly ReturnType<typeof member>[]) =>
            reconcileApplication(
              { ...connection, entrypoint: member(source), workers },
              activationOwner,
            ).pipe(
              Effect.provide(
                Layer.mergeAll(
                  ManagementBindings,
                  Layer.succeed(FleetManagement, {
                    ...management,
                    activate: (connection, graph) =>
                      Effect.gen(function* () {
                        expect(
                          yield* f.store
                            .get(APPLICATION_LOCK_KEY)
                            .pipe(Effect.orDie),
                        ).toBeDefined();
                        const evidence = yield* management.activate(
                          connection,
                          graph,
                        );
                        expect(evidence.assurance).toBe(
                          "locked-graph-generation",
                        );
                        expect(
                          yield* f.store
                            .get(APPLICATION_LOCK_KEY)
                            .pipe(Effect.orDie),
                        ).toBeDefined();
                        return evidence;
                      }),
                  }),
                ),
              ),
            );
          yield* publish([]);
          expect(yield* f.store.get(APPLICATION_LOCK_KEY)).toBeUndefined();
          expect((yield* readPublicationReceipt(f.store))?.owner).toEqual(
            activationOwner,
          );
          expect((yield* readRetained).result[0]?.rows).toEqual([["retained"]]);
          expect(
            yield* readCatalog(connection, "d1", output.databaseId),
          ).toEqual(catalog);
          yield* f.operator.execD1(connection, {
            ...address,
            exec: {
              sql: "INSERT OR REPLACE INTO retained VALUES (2, 'after-application');",
            },
          });
          const secondary = yield* prepareDeployment({
            scriptName: "d1-bound-secondary",
            mainModule: "index.js",
            modules: [
              {
                name: "index.js",
                content:
                  "export default { fetch() { return new Response('bound'); } };",
              },
            ],
            metadata: {
              main_module: "index.js",
              compatibility_date: "2026-09-01",
              bindings: [
                { type: "d1", name: "DB", database_name: output.databaseId },
              ],
            },
            doClasses: [],
            sqliteClasses: [],
          });
          expect(secondary.manifest.do_classes).toEqual(["__D1Database"]);
          yield* stageDeployment(f.store, secondary);
          yield* publish([member(secondary)]);
          expect((yield* readRetained).result[0]?.rows).toEqual([["retained"]]);
          expect(yield* f.store.get(APPLICATION_LOCK_KEY)).toBeUndefined();
          expect((yield* readPublicationReceipt(f.store))?.owner).toEqual(
            activationOwner,
          );
          yield* provider.delete({ ...input, olds: news, output });
          expect(
            yield* readCatalog(connection, "d1", output.databaseId),
          ).toEqual({ ...catalog, retained: true });
          expect(
            (yield* f.operator.executeD1Statements(connection, {
              ...address,
              statements: [{ sql: "SELECT value FROM retained WHERE id = 2;" }],
            })).result[0]?.rows,
          ).toEqual([["after-application"]]);
          yield* Effect.log({
            bootstrapVersion: bootstrap.version,
            applicationRoot: (yield* readPublicationReceipt(f.store))?.root,
            databaseId: output.databaseId,
            retainedOwner: catalog?.owner,
            operatorReadWrite: "verified-after-unbound-application",
          });
          expect(
            (yield* f.operator.executeD1Statements(connection, {
              ...address,
              statements: [{ sql: "SELECT value FROM retained WHERE id = 1;" }],
            })).result[0]?.rows,
          ).toEqual([["retained"]]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  { timeout: 120_000, exclusive: true },
);
