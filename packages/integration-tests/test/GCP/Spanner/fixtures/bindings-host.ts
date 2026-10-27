import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordAuditLogs } from "../../auditLogs.ts";
import { outcome, probeParam, serveProbes } from "../../bindingHost.ts";

export const ITEMS_DDL = "CREATE TABLE Items (\n  Id STRING(36) NOT NULL,\n) PRIMARY KEY(Id)";

export const Db = GCP.Spanner.Instance("Db", {
  config: "regional-us-central1",
  processingUnits: 100,
});

/** Database `GetDdl` reads (roles/spanner.databaseReader). */
export const Schema = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Spanner.Database("Schema", {
    instance: instance.name,
    extraStatements: [ITEMS_DDL],
  });
});

/** Database `ExecuteSql` queries (roles/spanner.databaseUser). */
export const App = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Spanner.Database("App", {
    instance: instance.name,
    extraStatements: [ITEMS_DDL],
  });
});

/** Database the generated session, DDL and backup-schedule bindings bind. */
export const Gen = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Spanner.Database("Gen", {
    instance: instance.name,
    extraStatements: [ITEMS_DDL],
  });
});

/**
 * Spanner keeps a backup at most a year: expire it 30 days out, at the start
 * of a UTC day so redeploys within a day don't move it.
 */
const inDays = (days: number) => {
  const time = new Date();
  time.setUTCHours(0, 0, 0, 0);
  time.setUTCDate(time.getUTCDate() + days);
  return time.toISOString();
};

/** A backup of {@link Gen} that `GetInstanceBackup` reads. */
export const GenBackup = Effect.gen(function* () {
  const instance = yield* Db;
  const database = yield* Gen;
  return yield* GCP.Spanner.InstancesBackup("GenBackup", {
    instance: instance.name,
    database: database.name,
    expireTime: inDays(30),
  });
});

/** A schedule on {@link Gen} the backup-schedule bindings read. */
export const GenSchedule = Effect.gen(function* () {
  const instance = yield* Db;
  const database = yield* Gen;
  return yield* GCP.Spanner.InstancesDatabasesBackupSchedule("GenSchedule", {
    instance: instance.name,
    database: database.name,
    backupScheduleId: "daily",
    spec: { cron: "0 2 * * *" },
    retentionDuration: "86400s",
  });
});

/**
 * Effect-native Cloud Run service exercising every Spanner binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */

/** Bucket the audit-log consumers record entries in. */
export const AuditMarkers = GCP.Storage.Bucket("AuditMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

export default class SpannerBindingsHost extends GCP.Function<SpannerBindingsHost>()(
  "SpannerBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const putMarker = yield* GCP.Storage.PutObject(AuditMarkers);
    yield* GCP.Spanner.consumeInstanceAuditLogs(
      Db,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("instance", putMarker),
    );
    yield* GCP.Spanner.consumeDatabaseAuditLogs(
      Gen,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("database", putMarker),
    );
    yield* GCP.Spanner.consumeInstancesBackupAuditLogs(
      GenBackup,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("backup", putMarker),
    );
    const getInstance = yield* GCP.Spanner.GetInstance(Db);
    const getDdl = yield* GCP.Spanner.GetDdl(Schema);
    const executeSql = yield* GCP.Spanner.ExecuteSql(App);

    const S = GCP.Spanner;
    const getDatabase = yield* S.GetDatabase(Gen);
    const listRoles = yield* S.ListDatabaseRoles(Gen);
    const updateDdl = yield* S.UpdateDatabaseDdl(Gen);
    const addSplitPoints = yield* S.AddDatabaseSplitPoints(Gen);
    const changeQuorum = yield* S.ChangeDatabaseQuorum(Gen);
    const batchCreateSessions = yield* S.BatchCreateSessions(Gen);
    const listSessions = yield* S.ListDatabaseSessions(Gen);
    const getSession = yield* S.GetDatabaseSession(Gen);
    const deleteSession = yield* S.DeleteDatabaseSession(Gen);
    const beginTransaction = yield* S.BeginTransaction(Gen);
    const executeBatchDml = yield* S.ExecuteBatchDml(Gen);
    const commit = yield* S.Commit(Gen);
    const rollback = yield* S.Rollback(Gen);
    const read = yield* S.Read(Gen);
    const partitionQuery = yield* S.PartitionQuery(Gen);
    const partitionRead = yield* S.PartitionRead(Gen);
    const listSchedules = yield* S.ListDatabaseBackupSchedules(Gen);
    const getSchedule = yield* S.GetDatabaseBackupSchedule(Gen);
    const getBackup = yield* S.GetInstanceBackup(GenBackup);
    const listBackups = yield* S.ListInstanceBackups(Db);
    const listBackupOperations = yield* S.ListInstanceBackupOperations(Db);
    const listDatabases = yield* S.ListInstanceDatabases(Db);
    const listDatabaseOperations = yield* S.ListInstanceDatabaseOperations(Db);
    const listPartitions = yield* S.ListInstancePartitions(Db);
    const listPartitionOperations = yield* S.ListInstancePartitionOperations(Db);
    const getPartition = yield* S.GetInstancePartition(Db);
    const copyBackup = yield* S.CopyInstanceBackup(Db);
    const restore = yield* S.RestoreInstanceDatabase(Db);
    const move = yield* S.MoveInstance(Db);

    const session = probeParam("session");
    const ITEM = "binding-item";

    return {
      fetch: serveProbes({
        database: Effect.all({ database: getDatabase(), roles: listRoles() }),
        updateDdl: updateDdl({
          body: { statements: ["CREATE INDEX ItemsById ON Items(Id)"] },
        }),
        addSplitPoints: addSplitPoints({
          body: {
            splitPoints: [
              {
                table: "Items",
                keys: [{ keyParts: ["m"] }],
                expireTime: inDays(5),
              },
            ],
          },
        }),
        // Quorum changes apply only to dual-region instances.
        changeQuorum: outcome(changeQuorum({ body: { quorumType: { singleRegion: {} } } })),
        createSession: batchCreateSessions({ body: { sessionCount: 1 } }),
        listSessions: listSessions(),
        getSession: Effect.flatMap(session, (id) => getSession({ session: id })),
        write: Effect.gen(function* () {
          const id = yield* session;
          const { id: transaction } = yield* beginTransaction({
            session: id,
            body: { options: { readWrite: {} } },
          });
          const dml = yield* executeBatchDml({
            session: id,
            body: {
              transaction: { id: transaction },
              seqno: "1",
              statements: [{ sql: `INSERT INTO Items (Id) VALUES ('${ITEM}')` }],
            },
          });
          const committed = yield* commit({ session: id, body: { transactionId: transaction } });
          const rolledBack = yield* beginTransaction({
            session: id,
            body: { options: { readWrite: {} } },
          });
          yield* rollback({ session: id, body: { transactionId: rolledBack.id } });
          return { dml, commitTimestamp: committed.commitTimestamp };
        }),
        read: Effect.flatMap(session, (id) =>
          read({
            session: id,
            body: { table: "Items", columns: ["Id"], keySet: { all: true } },
          }),
        ),
        partitions: Effect.gen(function* () {
          const id = yield* session;
          const readOnly = { begin: { readOnly: { strong: true } } };
          return {
            query: yield* partitionQuery({
              session: id,
              body: { sql: "SELECT Id FROM Items", transaction: readOnly },
            }),
            read: yield* partitionRead({
              session: id,
              body: {
                table: "Items",
                columns: ["Id"],
                keySet: { all: true },
                transaction: readOnly,
              },
            }),
          };
        }),
        deleteSession: Effect.flatMap(session, (id) => deleteSession({ session: id })),
        schedules: Effect.all({
          list: listSchedules(),
          get: getSchedule({ backupSchedule: "daily" }),
        }),
        backups: Effect.all({
          backup: getBackup(),
          list: listBackups(),
          operations: listBackupOperations(),
        }),
        instance: Effect.all({
          databases: listDatabases(),
          databaseOperations: listDatabaseOperations(),
          partitions: listPartitions(),
          partitionOperations: listPartitionOperations(),
          missingPartition: outcome(getPartition({ instancePartition: "none" })),
        }),
        // Each is authorized and refused: copying a backup that doesn't exist,
        // restoring onto an existing database, moving to the current config.
        refused: Effect.gen(function* () {
          const database = yield* getDatabase();
          const instance = database.name!.split("/databases/")[0]!;
          return {
            copy: yield* outcome(
              copyBackup({
                body: {
                  backupId: "copy",
                  sourceBackup: `${instance}/backups/none`,
                  expireTime: inDays(30),
                },
              }),
            ),
            restore: yield* outcome(
              restore({
                body: {
                  databaseId: database.name!.split("/").at(-1)!,
                  backup: `${instance}/backups/none`,
                },
              }),
            ),
            move: yield* outcome(move({ body: { targetConfig: "" } })),
          };
        }),
        getInstance: getInstance(),
        getDdl: getDdl(),
        executeSql: executeSql({
          sql: "SELECT COUNT(*) AS n FROM Items WHERE Id != @id",
          params: { id: "none" },
          paramTypes: { id: { code: "STRING" } },
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Spanner.GetInstanceHttp),
    Effect.provide(GCP.Spanner.GetDdlHttp),
    Effect.provide(GCP.Spanner.ExecuteSqlHttp),
    Effect.provide(
      Layer.mergeAll(
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
        GCP.Spanner.GetDatabaseHttp,
        GCP.Spanner.ListDatabaseRolesHttp,
        GCP.Spanner.UpdateDatabaseDdlHttp,
        GCP.Spanner.AddDatabaseSplitPointsHttp,
        GCP.Spanner.ChangeDatabaseQuorumHttp,
        GCP.Spanner.BatchCreateSessionsHttp,
        GCP.Spanner.ListDatabaseSessionsHttp,
        GCP.Spanner.GetDatabaseSessionHttp,
        GCP.Spanner.DeleteDatabaseSessionHttp,
        GCP.Spanner.BeginTransactionHttp,
        GCP.Spanner.ExecuteBatchDmlHttp,
        GCP.Spanner.CommitHttp,
        GCP.Spanner.RollbackHttp,
        GCP.Spanner.ReadHttp,
        GCP.Spanner.PartitionQueryHttp,
        GCP.Spanner.PartitionReadHttp,
        GCP.Spanner.ListDatabaseBackupSchedulesHttp,
        GCP.Spanner.GetDatabaseBackupScheduleHttp,
        GCP.Spanner.GetInstanceBackupHttp,
        GCP.Spanner.ListInstanceBackupsHttp,
        GCP.Spanner.ListInstanceBackupOperationsHttp,
        GCP.Spanner.ListInstanceDatabasesHttp,
        GCP.Spanner.ListInstanceDatabaseOperationsHttp,
        GCP.Spanner.ListInstancePartitionsHttp,
        GCP.Spanner.ListInstancePartitionOperationsHttp,
        GCP.Spanner.GetInstancePartitionHttp,
        GCP.Spanner.CopyInstanceBackupHttp,
        GCP.Spanner.RestoreInstanceDatabaseHttp,
        GCP.Spanner.MoveInstanceHttp,
      ),
    ),
  ),
) {}
