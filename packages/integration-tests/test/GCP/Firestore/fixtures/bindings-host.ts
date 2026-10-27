import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordAuditLogs } from "../../auditLogs.ts";
import { outcome, probeParam, serveProbes } from "../../bindingHost.ts";

const nativeDatabase = (id: string) =>
  GCP.Firestore.Database(id, {
    location: "us-central1",
    type: "FIRESTORE_NATIVE",
  });

/** Database the per-document PatchDocument / GetDocument / DeleteDocument bind. */
export const DocsDatabase = nativeDatabase("DocsDatabase");
/** Database only {@link GCP.Firestore.ReadDatabase} binds (seeded by the test). */
export const ReadOnlyDatabase = nativeDatabase("ReadOnlyDatabase");
/** Database only {@link GCP.Firestore.WriteDatabase} binds. */
export const WriteOnlyDatabase = nativeDatabase("WriteOnlyDatabase");
/** Database only {@link GCP.Firestore.ReadWriteDatabase} binds. */
export const ReadWriteOnlyDatabase = nativeDatabase("ReadWriteOnlyDatabase");

/** Database the generated bindings bind. */
export const GenDatabase = nativeDatabase("GenDatabase");

/** Enterprise-edition database: user credentials exist only there. */
export const EnterpriseDatabase = GCP.Firestore.Database("EnterpriseDatabase", {
  location: "us-central1",
  type: "FIRESTORE_NATIVE",
  databaseEdition: "ENTERPRISE",
});

/** A bucket that doesn't exist: imports and exports reach the API and fail there. */
const MISSING_GCS = "gs://alchemy-binding-missing-bucket/none";

/** Documents the test seeds out of band. */
export const SEEDED_GET = "users/seeded";
export const SEEDED_DELETE = "users/doomed";
export const PATCHED = "users/alice";

/**
 * Effect-native Cloud Run service exercising every Firestore binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */

/** Bucket the audit-log consumers record entries in. */
export const AuditMarkers = GCP.Storage.Bucket("AuditMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

export default class FirestoreBindingsHost extends GCP.Function<FirestoreBindingsHost>()(
  "FirestoreBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const putMarker = yield* GCP.Storage.PutObject(AuditMarkers);
    yield* GCP.Firestore.consumeDatabaseAuditLogs(
      GenDatabase,
      { methods: ["UpdateDatabase"] },
      recordAuditLogs("database", putMarker),
    );
    const patchDocument = yield* GCP.Firestore.PatchDocument(DocsDatabase);
    const getDocument = yield* GCP.Firestore.GetDocument(DocsDatabase);
    const deleteDocument = yield* GCP.Firestore.DeleteDocument(DocsDatabase);
    const reader = yield* GCP.Firestore.ReadDatabase(ReadOnlyDatabase);
    const writer = yield* GCP.Firestore.WriteDatabase(WriteOnlyDatabase);
    const both = yield* GCP.Firestore.ReadWriteDatabase(ReadWriteOnlyDatabase);

    const F = GCP.Firestore;
    const getDatabase = yield* F.GetDatabase(GenDatabase);
    const commit = yield* F.Commit(GenDatabase);
    const batchGet = yield* F.BatchGetDocuments(GenDatabase);
    const batchWrite = yield* F.BatchWriteDocuments(GenDatabase);
    const beginTransaction = yield* F.BeginTransaction(GenDatabase);
    const rollback = yield* F.Rollback(GenDatabase);
    const listDocuments = yield* F.ListDocuments(GenDatabase);
    const listCollectionIds = yield* F.ListCollectionIds(GenDatabase);
    const runAggregationQuery = yield* F.RunAggregationQuery(GenDatabase);
    const partitionQuery = yield* F.PartitionQuery(GenDatabase);
    const executePipeline = yield* F.ExecutePipeline(GenDatabase);
    const bulkDelete = yield* F.BulkDeleteDocuments(GenDatabase);
    const exportDocuments = yield* F.ExportDocuments(GenDatabase);
    const importDocuments = yield* F.ImportDocuments(GenDatabase);
    const createIndex = yield* F.CreateDatabaseCollectionGroupIndex(GenDatabase);
    const listIndexes = yield* F.ListDatabaseCollectionGroupIndexes(GenDatabase);
    const getIndex = yield* F.GetDatabaseCollectionGroupIndex(GenDatabase);
    const deleteIndex = yield* F.DeleteDatabaseCollectionGroupIndex(GenDatabase);
    const getField = yield* F.GetDatabaseCollectionGroupField(GenDatabase);
    const listFields = yield* F.ListDatabaseCollectionGroupFields(GenDatabase);
    const patchField = yield* F.PatchDatabaseCollectionGroupField(GenDatabase);
    const createSchedule = yield* F.CreateDatabaseBackupSchedule(GenDatabase);
    const listSchedules = yield* F.ListDatabaseBackupSchedules(GenDatabase);
    const getSchedule = yield* F.GetDatabaseBackupSchedule(GenDatabase);
    const patchSchedule = yield* F.PatchDatabaseBackupSchedule(GenDatabase);
    const deleteSchedule = yield* F.DeleteDatabaseBackupSchedule(GenDatabase);
    const createUserCred = yield* F.CreateDatabaseUserCred(EnterpriseDatabase);
    const listUserCreds = yield* F.ListDatabaseUserCreds(EnterpriseDatabase);
    const getUserCred = yield* F.GetDatabaseUserCred(EnterpriseDatabase);
    const enableUserCred = yield* F.EnableDatabaseUserCred(EnterpriseDatabase);
    const disableUserCred = yield* F.DisableDatabaseUserCred(EnterpriseDatabase);
    const resetUserCred = yield* F.ResetUserCredPassword(EnterpriseDatabase);
    const deleteUserCred = yield* F.DeleteDatabaseUserCred(EnterpriseDatabase);

    /** `gen/<id>` documents' full names on {@link GenDatabase}. */
    const docName = (id: string) =>
      Effect.map(getDatabase(), (database) => `${database.name}/documents/gen/${id}`);
    const thingsQuery = { from: [{ collectionId: "gen" }] };

    return {
      fetch: serveProbes({
        getDatabase: getDatabase(),
        commit: Effect.gen(function* () {
          const a = yield* docName("a");
          const b = yield* docName("b");
          return yield* commit({
            body: {
              writes: [
                { update: { name: a, fields: { n: { integerValue: "1" } } } },
                { update: { name: b, fields: { n: { integerValue: "2" } } } },
              ],
            },
          });
        }),
        batchGet: Effect.gen(function* () {
          const documents = [yield* docName("a"), yield* docName("b")];
          return yield* batchGet({ body: { documents } });
        }),
        batchWrite: Effect.gen(function* () {
          const c = yield* docName("c");
          return yield* batchWrite({
            body: { writes: [{ update: { name: c, fields: { n: { integerValue: "3" } } } }] },
          });
        }),
        transaction: Effect.gen(function* () {
          const begun = yield* beginTransaction({ body: {} });
          yield* rollback({ body: { transaction: begun.transaction } });
          return { transaction: begun.transaction !== undefined };
        }),
        listDocuments: listDocuments({ collectionId: "gen" }),
        listCollectionIds: listCollectionIds({ body: {} }),
        count: runAggregationQuery({
          body: {
            structuredAggregationQuery: {
              structuredQuery: thingsQuery,
              aggregations: [{ alias: "total", count: {} }],
            },
          },
        }),
        partitionQuery: partitionQuery({
          body: {
            partitionCount: "2",
            structuredQuery: {
              from: [{ collectionId: "gen", allDescendants: true }],
              orderBy: [{ field: { fieldPath: "__name__" } }],
            },
          },
        }),
        executePipeline: outcome(executePipeline({ body: {} })),
        bulkDelete: bulkDelete({ body: { collectionIds: ["gen-doomed"] } }),
        exportImport: Effect.all({
          export: outcome(exportDocuments({ body: { outputUriPrefix: MISSING_GCS } })),
          import: outcome(importDocuments({ body: { inputUriPrefix: MISSING_GCS } })),
        }),
        // Conflict: distilled retried a create the server had already accepted.
        createIndex: outcome(
          createIndex({
            collectionGroup: "gen",
            body: {
              queryScope: "COLLECTION",
              fields: [
                { fieldPath: "n", order: "ASCENDING" },
                { fieldPath: "m", order: "DESCENDING" },
              ],
            },
          }),
        ),
        listIndexes: listIndexes({ collectionGroup: "gen" }),
        getIndex: Effect.flatMap(probeParam("index"), (index) =>
          getIndex({ collectionGroup: "gen", index }),
        ),
        deleteIndex: Effect.flatMap(probeParam("index"), (index) =>
          deleteIndex({ collectionGroup: "gen", index }),
        ),
        fields: Effect.all({
          default: getField({ collectionGroup: "__default__", field: "*" }),
          list: listFields({ collectionGroup: "gen", filter: "ttlConfig:*" }),
        }),
        patchField: patchField({
          collectionGroup: "gen",
          field: "expireAt",
          updateMask: "ttlConfig",
          body: { ttlConfig: {} },
        }),
        createSchedule: createSchedule({
          body: { retention: "604800s", dailyRecurrence: {} },
        }),
        listSchedules: listSchedules(),
        getSchedule: Effect.flatMap(probeParam("schedule"), (backupSchedule) =>
          getSchedule({ backupSchedule }),
        ),
        patchSchedule: Effect.flatMap(probeParam("schedule"), (backupSchedule) =>
          patchSchedule({
            backupSchedule,
            updateMask: "retention",
            body: { retention: "1209600s" },
          }),
        ),
        deleteSchedule: Effect.flatMap(probeParam("schedule"), (backupSchedule) =>
          deleteSchedule({ backupSchedule }),
        ),
        // A credential's lifecycle on the Enterprise database.
        createUserCred: Effect.flatMap(probeParam("id"), (id) =>
          createUserCred({ userCredsId: id, body: {} }),
        ),
        listUserCreds: listUserCreds(),
        getUserCred: Effect.flatMap(probeParam("id"), (id) => getUserCred({ userCred: id })),
        disableUserCred: Effect.flatMap(probeParam("id"), (id) =>
          disableUserCred({ userCred: id, body: {} }),
        ),
        enableUserCred: Effect.flatMap(probeParam("id"), (id) =>
          enableUserCred({ userCred: id, body: {} }),
        ),
        resetUserCred: Effect.flatMap(probeParam("id"), (id) =>
          resetUserCred({ userCred: id, body: {} }),
        ),
        deleteUserCred: Effect.flatMap(probeParam("id"), (id) => deleteUserCred({ userCred: id })),
        patchDocument: patchDocument({
          documentPath: PATCHED,
          body: { fields: { name: { stringValue: "Alice" } } },
        }),
        getDocument: getDocument({ documentPath: SEEDED_GET }),
        deleteDocument: deleteDocument({ documentPath: SEEDED_DELETE }),
        read: Effect.gen(function* () {
          const one = yield* reader.get("things/a");
          const missing = yield* reader.get("things/never");
          const page1 = yield* reader.list("things", { pageSize: 1 });
          const page2 = yield* reader.list("things", {
            pageSize: 1,
            pageToken: page1.nextPageToken,
          });
          const big = yield* reader.query({
            from: [{ collectionId: "things" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "n" },
                op: "GREATER_THAN",
                value: { integerValue: "1" },
              },
            },
          });
          return {
            one: one?.fields,
            missing: missing === undefined,
            listed: [...page1.documents, ...page2.documents]
              .map((doc) => doc.name.split("/").pop())
              .sort(),
            hasNextPage: page1.nextPageToken !== undefined,
            big: big.map((doc) => doc.fields.n),
          };
        }),
        write: Effect.gen(function* () {
          yield* writer.delete("things/created");
          const created = yield* writer.create("things/created", { n: 1 });
          const conflict = yield* writer.create("things/created", { n: 2 }).pipe(
            Effect.map(() => "created"),
            Effect.catchTag("GCP.Firestore.DocumentAlreadyExists", (error) =>
              Effect.succeed(error.path),
            ),
          );
          const updated = yield* writer.update("things/created", {
            "odd key": "x",
          });
          const updateMissing = yield* writer.update("things/never", { a: 1 }).pipe(
            Effect.map(() => "updated"),
            Effect.catchTag("NotFound", () => Effect.succeed("NotFound")),
          );
          yield* writer.set("things/set", { team: "red" });
          yield* writer.set("things/gone", { team: "blue" });
          yield* writer.delete("things/gone");
          yield* writer.delete("things/never-existed");
          return {
            created: created.name.endsWith("/documents/things/created"),
            conflict,
            updated: updated.fields,
            updateMissing,
          };
        }),
        readWrite: Effect.gen(function* () {
          yield* both.delete("scores/a");
          const missing = yield* both.get("scores/a");
          yield* both.create("scores/a", { team: "red", n: 1 });
          yield* both.set("scores/b", { team: "blue", n: 2 });
          yield* both.update("scores/b", { n: 3 });
          const b = yield* both.get("scores/b");
          const listed = yield* both.list("scores");
          const red = yield* both.query({
            from: [{ collectionId: "scores" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "team" },
                op: "EQUAL",
                value: { stringValue: "red" },
              },
            },
          });
          yield* both.delete("scores/a");
          const afterDelete = yield* both.get("scores/a");
          return {
            missing: missing === undefined,
            b: b?.fields,
            listed: listed.documents.map((doc) => doc.name.split("/").pop()).sort(),
            red: red.map((doc) => doc.name.split("/").pop()),
            afterDelete: afterDelete === undefined,
          };
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Firestore.PatchDocumentHttp),
    Effect.provide(GCP.Firestore.GetDocumentHttp),
    Effect.provide(GCP.Firestore.DeleteDocumentHttp),
    Effect.provide(GCP.Firestore.ReadDatabaseHttp),
    Effect.provide(GCP.Firestore.WriteDatabaseHttp),
    Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp),
    Effect.provide(
      Layer.mergeAll(
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
        GCP.Firestore.GetDatabaseHttp,
        GCP.Firestore.CommitHttp,
        GCP.Firestore.BatchGetDocumentsHttp,
        GCP.Firestore.BatchWriteDocumentsHttp,
        GCP.Firestore.BeginTransactionHttp,
        GCP.Firestore.RollbackHttp,
        GCP.Firestore.ListDocumentsHttp,
        GCP.Firestore.ListCollectionIdsHttp,
        GCP.Firestore.RunAggregationQueryHttp,
        GCP.Firestore.PartitionQueryHttp,
        GCP.Firestore.ExecutePipelineHttp,
        GCP.Firestore.BulkDeleteDocumentsHttp,
        GCP.Firestore.ExportDocumentsHttp,
        GCP.Firestore.ImportDocumentsHttp,
        GCP.Firestore.CreateDatabaseCollectionGroupIndexHttp,
        GCP.Firestore.ListDatabaseCollectionGroupIndexesHttp,
        GCP.Firestore.GetDatabaseCollectionGroupIndexHttp,
        GCP.Firestore.DeleteDatabaseCollectionGroupIndexHttp,
        GCP.Firestore.GetDatabaseCollectionGroupFieldHttp,
        GCP.Firestore.ListDatabaseCollectionGroupFieldsHttp,
        GCP.Firestore.PatchDatabaseCollectionGroupFieldHttp,
        GCP.Firestore.CreateDatabaseBackupScheduleHttp,
        GCP.Firestore.ListDatabaseBackupSchedulesHttp,
        GCP.Firestore.GetDatabaseBackupScheduleHttp,
        GCP.Firestore.PatchDatabaseBackupScheduleHttp,
        GCP.Firestore.DeleteDatabaseBackupScheduleHttp,
        GCP.Firestore.CreateDatabaseUserCredHttp,
        GCP.Firestore.ListDatabaseUserCredsHttp,
        GCP.Firestore.GetDatabaseUserCredHttp,
        GCP.Firestore.EnableDatabaseUserCredHttp,
        GCP.Firestore.DisableDatabaseUserCredHttp,
        GCP.Firestore.ResetUserCredPasswordHttp,
        GCP.Firestore.DeleteDatabaseUserCredHttp,
      ),
    ),
  ),
) {}
