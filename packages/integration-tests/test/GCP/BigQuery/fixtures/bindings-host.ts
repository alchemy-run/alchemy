import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordAuditLogs } from "../../auditLogs.ts";
import { outcome, serveProbes } from "../../bindingHost.ts";

/** Dataset the Query binding reads (roles/bigquery.dataViewer on it). */
export const Analytics = GCP.BigQuery.Dataset("Analytics", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

const table = (id: string, tableId: string) =>
  Effect.gen(function* () {
    const dataset = yield* Analytics;
    return yield* GCP.BigQuery.Table(id, {
      datasetId: dataset.datasetId,
      tableId,
      schema: [{ name: "id", type: "STRING" }],
    });
  });

/** Seeded by the test; read by Query through the dataset grant. */
export const Queried = table("Queried", "queried");
/** Seeded by the test; read by ListTabledata. */
export const Listed = table("Listed", "listed");
/** Written by InsertAll. */
export const Inserted = table("Inserted", "inserted");
/** Seeded by the test; read by ReadTable. */
export const ReadRows = table("ReadRows", "read_rows");
/** Written by WriteTable. */
export const Written = table("Written", "written");
/** Written and read back by ReadWriteTable. */
export const ReadWrite = table("ReadWrite", "read_write");

/** Dataset and table the generated bindings bind. */
export const GenDataset = GCP.BigQuery.Dataset("GenDataset", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});
export const GenTable = Effect.gen(function* () {
  const dataset = yield* GenDataset;
  return yield* GCP.BigQuery.Table("GenTable", {
    datasetId: dataset.datasetId,
    tableId: "gen",
    schema: [{ name: "id", type: "STRING" }],
  });
});

/** A row access policy on {@link GenTable} the policy bindings read and batch-delete. */
export const GenPolicy = Effect.gen(function* () {
  const dataset = yield* GenDataset;
  const table = yield* GenTable;
  return yield* GCP.BigQuery.RowAccessPolicy("GenPolicy", {
    datasetId: dataset.datasetId,
    tableId: table.tableId,
    policyId: "gen_policy",
    filterPredicate: "id = 'visible'",
    grantees: ["allAuthenticatedUsers"],
  });
});

/** A finished query job the job bindings read and cancel. */
export const GenJob = GCP.BigQuery.Job("GenJob", {
  location: "US-CENTRAL1",
  query: { query: "SELECT 1 AS one", useLegacySql: false },
});

/** Bucket the audit-log consumers record entries in. */
export const AuditMarkers = GCP.Storage.Bucket("AuditMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/**
 * Effect-native Cloud Run service exercising every BigQuery binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class BigQueryBindingsHost extends GCP.Function<BigQueryBindingsHost>()(
  "BigQueryBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const query = yield* GCP.BigQuery.Query(Analytics);
    const insertAll = yield* GCP.BigQuery.InsertAll(Inserted);
    const listRows = yield* GCP.BigQuery.ListTabledata(Listed);
    const read = yield* GCP.BigQuery.ReadTable(ReadRows);
    const write = yield* GCP.BigQuery.WriteTable(Written);
    const readWrite = yield* GCP.BigQuery.ReadWriteTable(ReadWrite);

    const BQ = GCP.BigQuery;
    const getDataset = yield* BQ.GetDataset(GenDataset);
    const listTables = yield* BQ.ListTables(GenDataset);
    const listModels = yield* BQ.ListModels(GenDataset);
    const getModel = yield* BQ.GetModel(GenDataset);
    const patchModel = yield* BQ.PatchModel(GenDataset);
    const deleteModel = yield* BQ.DeleteModel(GenDataset);
    const listRoutines = yield* BQ.ListRoutines(GenDataset);
    const getRoutine = yield* BQ.GetRoutine(GenDataset);
    const undeleteDataset = yield* BQ.UndeleteDataset(GenDataset);
    const listPolicies = yield* BQ.ListRowAccessPolicies(GenTable);
    const getPolicy = yield* BQ.GetRowAccessPolicy(GenTable);
    const batchDeletePolicies = yield* BQ.BatchDeleteRowAccessPolicies(GenTable);
    const getJob = yield* BQ.GetJob(GenJob);
    const cancelJob = yield* BQ.CancelJob(GenJob);
    const listDatasets = yield* BQ.ListDatasets();
    const listJobs = yield* BQ.ListJobs();
    const insertJob = yield* BQ.InsertJob();

    const putMarker = yield* GCP.Storage.PutObject(AuditMarkers);
    yield* BQ.consumeDatasetAuditLogs(GenDataset, recordAuditLogs("dataset", putMarker));
    yield* BQ.consumeTableAuditLogs(GenTable, recordAuditLogs("table", putMarker));
    yield* BQ.consumeJobAuditLogs(GenJob, recordAuditLogs("job", putMarker));

    return {
      fetch: serveProbes({
        dataset: Effect.all({
          dataset: getDataset(),
          tables: listTables(),
          models: listModels(),
          routines: listRoutines(),
          // Nothing named "none" exists: each call is authorized and not found.
          missingModel: outcome(getModel({ modelId: "none" })),
          patchMissingModel: outcome(
            patchModel({ modelId: "none", body: { description: "patched" } }),
          ),
          deleteMissingModel: outcome(deleteModel({ modelId: "none" })),
          missingRoutine: outcome(getRoutine({ routineId: "none" })),
          // The dataset isn't deleted, so there is nothing to undelete.
          undelete: outcome(undeleteDataset({ body: {} })),
        }),
        policies: Effect.all({
          list: listPolicies(),
          get: getPolicy({ policyId: "gen_policy" }),
        }),
        batchDeletePolicies: batchDeletePolicies({
          body: { policyIds: ["gen_policy"], force: true },
        }),
        job: Effect.all({ get: getJob(), cancel: cancelJob() }),
        project: Effect.gen(function* () {
          const datasets = yield* listDatasets();
          const jobs = yield* listJobs({ maxResults: 10 });
          const inserted = yield* insertJob({
            body: {
              configuration: { query: { query: "SELECT 2 AS two", useLegacySql: false } },
            },
          });
          return { datasets, jobs, inserted };
        }),
        query: query({ query: "SELECT id FROM queried" }),
        insertAll: insertAll({
          body: {
            rows: [{ insertId: "insert-all", json: { id: "insert-all" } }],
          },
        }),
        listTabledata: listRows({ maxResults: 10 }),
        readTable: Effect.gen(function* () {
          const page = yield* read.list({ maxResults: 10 });
          const queried = yield* read.query("SELECT id FROM read_rows WHERE id = @id", {
            id: "seed",
          });
          return { listed: page.rows, queried };
        }),
        writeTable: write.insert([{ id: "written" }], {
          insertIds: ["written"],
        }),
        readWriteTable: Effect.gen(function* () {
          yield* readWrite.insert([{ id: "read-write" }], {
            insertIds: ["read-write"],
          });
          return yield* readWrite.query("SELECT id FROM read_write");
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.BigQuery.QueryHttp),
    Effect.provide(GCP.BigQuery.InsertAllHttp),
    Effect.provide(GCP.BigQuery.ListTabledataHttp),
    Effect.provide(GCP.BigQuery.ReadTableHttp),
    Effect.provide(GCP.BigQuery.WriteTableHttp),
    Effect.provide(GCP.BigQuery.ReadWriteTableHttp),
    Effect.provide(
      Layer.mergeAll(
        GCP.BigQuery.GetDatasetHttp,
        GCP.BigQuery.ListTablesHttp,
        GCP.BigQuery.ListModelsHttp,
        GCP.BigQuery.GetModelHttp,
        GCP.BigQuery.PatchModelHttp,
        GCP.BigQuery.DeleteModelHttp,
        GCP.BigQuery.ListRoutinesHttp,
        GCP.BigQuery.GetRoutineHttp,
        GCP.BigQuery.UndeleteDatasetHttp,
        GCP.BigQuery.ListRowAccessPoliciesHttp,
        GCP.BigQuery.GetRowAccessPolicyHttp,
        GCP.BigQuery.BatchDeleteRowAccessPoliciesHttp,
        GCP.BigQuery.GetJobHttp,
        GCP.BigQuery.CancelJobHttp,
        GCP.BigQuery.ListDatasetsHttp,
        GCP.BigQuery.ListJobsHttp,
        GCP.BigQuery.InsertJobHttp,
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
      ),
    ),
  ),
) {}
