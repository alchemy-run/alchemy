import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Effect from "effect/Effect";
import { expectAuditEntry } from "../auditLogs.ts";
import { expectProbe } from "../bindingHost.ts";
import BigQueryBindingsHost, {
  Analytics,
  AuditMarkers,
  GenDataset,
  GenJob,
  GenPolicy,
  GenTable,
  Inserted,
  Listed,
  Queried,
  ReadRows,
  ReadWrite,
  Written,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BigQueryBindings");

let baseUrl: string;
let hostAccount: string;
let dataset: { project: string; datasetId: string; location: string };
let gen: {
  datasetId: string;
  table: string;
  tableId: string;
  jobId: string;
  jobLocation: string;
  auditMarkers: string;
};
let tables: {
  queried: string;
  listed: string;
  inserted: string;
  readRows: string;
  written: string;
  readWrite: string;
};

/** Run a GoogleSQL statement as the deploying principal. */
const runQuery = (sql: string) =>
  bigquery
    .queryJobs({
      projectId: dataset.project,
      body: {
        query: sql,
        useLegacySql: false,
        location: dataset.location,
        defaultDataset: {
          projectId: dataset.project,
          datasetId: dataset.datasetId,
        },
        timeoutMs: 60_000,
      },
    })
    .pipe(
      Effect.map((response) => {
        expect(response.jobComplete).toEqual(true);
        return (response.rows ?? []).map((row) => row.f?.[0]?.v);
      }),
    );

/**
 * Seed one row with DML: committed storage is immediately visible to
 * tabledata.list (streamed rows may still sit in the buffer).
 */
const seed = (table: string) => runQuery(`INSERT INTO ${table} (id) VALUES ('seed')`);

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${dataset.project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${account}`))
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          }))
          .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? "")),
      ),
    );

/**
 * Roles only grantable on the project: running jobs (Query, ReadTable,
 * InsertJob), reading and cancelling jobs (jobs have no IAM policy),
 * listing datasets, and undeleting one (a deleted dataset has no policy).
 */
const PROJECT_GRANTS = [
  "roles/bigquery.admin",
  "roles/bigquery.jobUser",
  "roles/bigquery.resourceViewer",
  "roles/bigquery.routineMetadataViewer",
  "roles/bigquery.user",
].map((role) => ({ role, condition: undefined }));

/** Roles `account` holds on a table's own IAM policy. */
const tableRolesOf = (table: string, account: string) =>
  bigquery
    .getIamPolicyTables({
      resource: table,
      body: { options: { requestedPolicyVersion: 1 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${account}`))
          .map((binding) => binding.role),
      ),
    );

const LEGACY_DATASET_ROLES: Record<string, string> = {
  READER: "roles/bigquery.dataViewer",
  WRITER: "roles/bigquery.dataEditor",
  OWNER: "roles/bigquery.dataOwner",
};

describe(
  "BigQuery Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:bigquery", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* BigQueryBindingsHost;
            const analytics = yield* Analytics;
            const genDataset = yield* GenDataset;
            const genTable = yield* GenTable;
            const genJob = yield* GenJob;
            yield* GenPolicy;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              dataset: {
                project: analytics.project,
                datasetId: analytics.datasetId,
                location: analytics.location,
              },
              gen: {
                datasetId: genDataset.datasetId,
                table: genTable.name,
                tableId: genTable.tableId,
                jobId: genJob.jobId,
                jobLocation: genJob.location,
                auditMarkers: (yield* AuditMarkers).bucketName,
              },
              tables: {
                // Not bound by any table binding: deployed for Query.
                queried: (yield* Queried).name,
                listed: (yield* Listed).name,
                inserted: (yield* Inserted).name,
                readRows: (yield* ReadRows).name,
                written: (yield* Written).name,
                readWrite: (yield* ReadWrite).name,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        dataset = out.dataset;
        tables = out.tables;
        gen = out.gen;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Query", () => {
      test.provider(
        "queries the dataset as the host's service account, reading only that dataset",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("queried");
            const response = yield* expectProbe<bigquery.QueryResponse>(baseUrl, "query");
            expect(response.jobComplete).toEqual(true);
            expect((response.rows ?? []).map((row) => row.f?.[0]?.v)).toEqual(["seed"]);

            const live = yield* bigquery.getDatasets({
              projectId: dataset.project,
              datasetId: dataset.datasetId,
            });
            const datasetRoles = (live.access ?? [])
              .filter((item) => item.userByEmail === hostAccount)
              .map((item) => LEGACY_DATASET_ROLES[item.role!] ?? item.role);
            expect(datasetRoles).toEqual(["roles/bigquery.dataViewer"]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("InsertAll", () => {
      test.provider(
        "streams a row as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            const response = yield* expectProbe<{
              insertErrors?: unknown[];
            }>(baseUrl, "insertAll");
            expect(response.insertErrors ?? []).toEqual([]);
            expect(yield* runQuery("SELECT id FROM inserted")).toEqual(["insert-all"]);
            expect(yield* tableRolesOf(tables.inserted, hostAccount)).toEqual([
              "roles/bigquery.dataEditor",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ListTabledata", () => {
      test.provider(
        "lists rows as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("listed");
            const page = yield* expectProbe<bigquery.TableDataList>(baseUrl, "listTabledata");
            expect((page.rows ?? []).map((row) => row.f?.[0]?.v)).toEqual(["seed"]);
            expect(yield* tableRolesOf(tables.listed, hostAccount)).toEqual([
              "roles/bigquery.dataViewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadTable", () => {
      test.provider(
        "lists and queries the table as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("read_rows");
            const out = yield* expectProbe<{
              listed: Array<{ id: string }>;
              queried: Array<{ id: string }>;
            }>(baseUrl, "readTable");
            expect(out.listed).toEqual([{ id: "seed" }]);
            expect(out.queried).toEqual([{ id: "seed" }]);
            expect(yield* tableRolesOf(tables.readRows, hostAccount)).toEqual([
              "roles/bigquery.dataViewer",
            ]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteTable", () => {
      test.provider(
        "inserts a row as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            yield* expectProbe(baseUrl, "writeTable");
            expect(yield* runQuery("SELECT id FROM written")).toEqual(["written"]);
            expect(yield* tableRolesOf(tables.written, hostAccount)).toEqual([
              "roles/bigquery.dataEditor",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadWriteTable", () => {
      test.provider(
        "inserts and reads back a row as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const rows = yield* expectProbe<Array<{ id: string }>>(baseUrl, "readWriteTable");
            expect(rows).toEqual([{ id: "read-write" }]);
            expect(yield* runQuery("SELECT id FROM read_write")).toEqual(["read-write"]);
            expect(yield* tableRolesOf(tables.readWrite, hostAccount)).toEqual([
              "roles/bigquery.dataEditor",
            ]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("generated dataset bindings", () => {
      test.provider(
        "reads the dataset and its children, granted on the dataset only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              dataset: bigquery.Dataset;
              tables: bigquery.TableList;
              models: bigquery.ListModelsResponse;
              routines: bigquery.ListRoutinesResponse;
              missingModel: string;
              patchMissingModel: string;
              deleteMissingModel: string;
              missingRoutine: string;
              undelete: string;
            }>(baseUrl, "dataset");
            expect(out.dataset.datasetReference?.datasetId).toEqual(gen.datasetId);
            expect((out.tables.tables ?? []).map((t) => t.tableReference?.tableId)).toEqual([
              gen.tableId,
            ]);
            expect(out.models.models ?? []).toEqual([]);
            expect(out.routines.routines ?? []).toEqual([]);
            expect(out.missingModel).toEqual("NotFound");
            expect(out.patchMissingModel).toEqual("NotFound");
            expect(out.deleteMissingModel).toEqual("NotFound");
            expect(out.missingRoutine).toEqual("NotFound");
            expect(out.undelete).not.toEqual("succeeded");

            const live = yield* bigquery.getDatasets({
              projectId: dataset.project,
              datasetId: gen.datasetId,
            });
            const roles = (live.access ?? [])
              .filter((item) => item.userByEmail === hostAccount)
              .map((item) => LEGACY_DATASET_ROLES[item.role!] ?? item.role)
              .sort();
            expect(roles).toEqual([
              "roles/bigquery.dataEditor",
              "roles/bigquery.metadataViewer",
              "roles/bigquery.routineMetadataViewer",
            ]);
          }),
        { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 600_000 },
      );
    });

    describe("generated row access policy bindings", () => {
      test.provider(
        "reads then batch-deletes the table's policy, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            const policies = yield* expectProbe<{
              list: bigquery.ListRowAccessPoliciesResponse;
              get: bigquery.RowAccessPolicy;
            }>(baseUrl, "policies");
            expect(
              (policies.list.rowAccessPolicies ?? []).map(
                (policy) => policy.rowAccessPolicyReference?.policyId,
              ),
            ).toEqual(["gen_policy"]);
            expect(policies.get.filterPredicate).toEqual("id = 'visible'");

            yield* expectProbe(baseUrl, "batchDeletePolicies");
            const after = yield* bigquery.listRowAccessPolicies({
              projectId: dataset.project,
              datasetId: gen.datasetId,
              tableId: gen.tableId,
            });
            expect(after.rowAccessPolicies ?? []).toEqual([]);
            expect(yield* tableRolesOf(gen.table, hostAccount)).toEqual([
              "roles/bigquery.securityAdmin",
            ]);
          }),
        { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 600_000 },
      );
    });

    describe("generated job and project bindings", () => {
      test.provider(
        "reads and cancels the bound job, and lists and runs jobs in the project",
        (_stack) =>
          Effect.gen(function* () {
            const job = yield* expectProbe<{
              get: bigquery.Job;
              cancel: bigquery.JobCancelResponse;
            }>(baseUrl, "job");
            expect(job.get.jobReference?.jobId).toEqual(gen.jobId);
            expect(job.cancel.job?.status?.state).toEqual("DONE");

            const project = yield* expectProbe<{
              datasets: bigquery.DatasetList;
              jobs: bigquery.JobList;
              inserted: bigquery.Job;
            }>(baseUrl, "project");
            const datasetIds = (project.datasets.datasets ?? []).map(
              (item) => item.datasetReference?.datasetId,
            );
            expect(datasetIds).toContain(gen.datasetId);
            expect(datasetIds).toContain(dataset.datasetId);
            expect(project.jobs.jobs?.length ?? 0).toBeGreaterThan(0);
            expect(project.inserted.configuration?.query?.query).toEqual("SELECT 2 AS two");
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 600_000 },
      );
    });

    describe("audit logs", () => {
      test.provider(
        "delivers the dataset's, table's and job's audit entries",
        (_stack) =>
          Effect.gen(function* () {
            const cases = [
              {
                key: "dataset",
                name: `projects/${dataset.project}/datasets/${gen.datasetId}`,
                trigger: bigquery.patchDatasets({
                  projectId: dataset.project,
                  datasetId: gen.datasetId,
                  body: { description: "audited" },
                }),
              },
              {
                key: "table",
                name: gen.table,
                trigger: bigquery.patchTables({
                  projectId: dataset.project,
                  datasetId: gen.datasetId,
                  tableId: gen.tableId,
                  body: { description: "audited" },
                }),
              },
              {
                key: "job",
                name: `projects/${dataset.project}/jobs/${gen.jobId}`,
                trigger: bigquery.cancelJobs({
                  projectId: dataset.project,
                  jobId: gen.jobId,
                  location: gen.jobLocation,
                }),
              },
            ];
            for (const { key, name, trigger } of cases) {
              const entry = yield* expectAuditEntry({
                bucket: gen.auditMarkers,
                key,
                method: "",
                trigger,
              });
              expect(entry.serviceName).toEqual("bigquery.googleapis.com");
              const path = (value: string) => value.replace(/^projects\/[^/]+/, "");
              expect(path(entry.resourceName).startsWith(path(name))).toEqual(true);
            }
          }),
        { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 900_000 },
      );
    });
  },
);
