import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectAuditEntry } from "../auditLogs.ts";
import { callProbe, expectProbe } from "../bindingHost.ts";
import BigtableBindingsHost, {
  AuditMarkers,
  Db,
  GenBackup,
  GenRows,
  Nodes,
  Rows,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BigtableBindings");

let baseUrl: string;
let auditMarkers: string;
let hostAccount: string;
let instanceName: string;
let clusterName: string;
let tableName: string;
let genTableName: string;
let backupName: string;

const hostRoles = (policy: bigtable.Policy) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
    .map((binding) => binding.role)
    .sort();

/**
 * On the instance: GetInstance, GetCluster and the generated reads grant
 * bigtable.viewer; copying a backup and restoring a table grant
 * bigtable.editor.
 */
const expectInstanceGrants = Effect.gen(function* () {
  const policy = yield* bigtable.getIamPolicyProjectsInstances({
    resource: instanceName,
    body: {},
  });
  expect(hostRoles(policy)).toEqual(["roles/bigtable.editor", "roles/bigtable.viewer"]);
});

/** GetTable grants bigtable.viewer on the table only. */
const expectTableGrants = Effect.gen(function* () {
  const policy = yield* bigtable.getIamPolicyProjectsInstancesTables({
    resource: tableName,
    body: {},
  });
  expect(hostRoles(policy)).toEqual(["roles/bigtable.viewer"]);
});

describe.skipIf(!!process.env.FAST)(
  "Bigtable Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:bigtable", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* BigtableBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              auditMarkers: (yield* AuditMarkers).bucketName,
              instance: (yield* Db).name,
              cluster: (yield* Nodes).name,
              table: (yield* Rows).name,
              genTable: (yield* GenRows).name,
              backup: (yield* GenBackup).name,
            };
          }),
        );
        baseUrl = out.uri!;
        auditMarkers = out.auditMarkers;
        hostAccount = out.serviceAccount!;
        instanceName = out.instance;
        clusterName = out.cluster;
        tableName = out.table;
        genTableName = out.genTable;
        backupName = out.backup;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetInstance", () => {
      test.provider(
        "reads the instance as the host's service account, granted on the instance only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<bigtable.Instance>(baseUrl, "getInstance");
            const actual = yield* bigtable.getProjectsInstances({
              name: instanceName,
            });
            expect(live.name).toEqual(instanceName);
            expect(live.displayName).toEqual(actual.displayName);
            expect(live.state).toEqual("READY");
            yield* expectInstanceGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigtable", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetCluster", () => {
      test.provider(
        "reads the cluster as the host's service account, granted on the instance only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<bigtable.Cluster>(baseUrl, "getCluster");
            expect(live.name).toEqual(clusterName);
            expect(live.serveNodes).toEqual(1);
            expect(live.defaultStorageType).toEqual("HDD");
            yield* expectInstanceGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigtable", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetTable", () => {
      test.provider(
        "reads the table as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<bigtable.Table>(baseUrl, "getTable");
            expect(live.name).toEqual(tableName);
            expect(Object.keys(live.columnFamilies ?? {})).toEqual(["cf"]);
            yield* expectTableGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigtable", "live"],
          timeout: 600_000,
        },
      );
    });

    const live = { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 600_000 };

    describe("GenerateTableConsistencyToken / CheckTableConsistency / DropTableRowRange / ModifyTableColumnFamilies / UndeleteTable / ListTableAuthorizedViews / GetTableAuthorizedView / ListTableSchemaBundles / GetTableSchemaBundle", () => {
      test.provider(
        "manages the table as the host, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            const consistent = yield* expectProbe<{ consistent?: boolean }>(baseUrl, "consistency");
            expect(consistent.consistent).toBe(true);
            yield* expectProbe(baseUrl, "dropRowRange");
            const added = yield* expectProbe<{ name?: string; columnFamilies?: object }>(
              baseUrl,
              "addFamily",
            );
            expect(added.name).toEqual(genTableName);
            expect(Object.keys(added.columnFamilies ?? {}).sort()).toEqual(["cf", "extra"]);
            // The add is still applying for a few seconds ("concurrent modifications").
            const dropped = yield* callProbe<{ columnFamilies?: object }>(
              baseUrl,
              "dropFamily",
            ).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (outcome) => outcome.ok,
                times: 12,
              }),
            );
            expect(dropped.ok && Object.keys(dropped.value.columnFamilies ?? {})).toEqual(["cf"]);
            expect(yield* expectProbe<string>(baseUrl, "undelete")).not.toEqual("succeeded");
            const children = yield* expectProbe<{
              missingAuthorizedView: string;
              missingSchemaBundle: string;
            }>(baseUrl, "tableChildren");
            expect(children.missingAuthorizedView).toEqual("NotFound");
            expect(children.missingSchemaBundle).toEqual("NotFound");

            const policy = yield* bigtable.getIamPolicyProjectsInstancesTables({
              resource: genTableName,
              body: {},
            });
            expect(hostRoles(policy)).toEqual([
              "roles/bigtable.editor",
              "roles/bigtable.user",
              "roles/bigtable.viewer",
            ]);
          }),
        live,
      );
    });

    describe("ListInstanceAppProfiles / GetInstanceAppProfile / ListInstanceClusters / ListInstanceTables / ListInstanceClusterBackups / GetInstanceClusterBackup / ListInstanceClusterHotTablets / ListInstanceClusterMemoryLayers / ListInstanceLogicalViews / GetInstanceLogicalView / ListInstanceMaterializedViews / GetInstanceMaterializedView / CopyInstanceClusterBackup / RestoreInstanceTable", () => {
      test.provider(
        "reads the instance's children and copies and restores a backup as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              defaultProfile: { name?: string };
              clusters: { clusters?: { name?: string }[] };
              tables: { tables?: { name?: string }[] };
              memoryLayers: string;
              missingLogicalView: string;
              missingMaterializedView: string;
            }>(baseUrl, "instance");
            expect(out.defaultProfile.name).toEqual(`${instanceName}/appProfiles/default`);
            expect(out.clusters.clusters?.map((c) => c.name)).toEqual([clusterName]);
            expect(out.tables.tables?.map((t) => t.name)).toEqual(
              expect.arrayContaining([tableName, genTableName]),
            );
            expect(out.memoryLayers).not.toEqual("Forbidden");
            expect(out.missingLogicalView).toEqual("NotFound");
            expect(out.missingMaterializedView).toEqual("NotFound");

            const backups = yield* expectProbe<{
              listed: { backups?: { name?: string }[] };
              backup: { name?: string; sourceTable?: string };
            }>(baseUrl, "backups");
            expect(backups.listed.backups?.map((b) => b.name)).toContain(backupName);
            expect(backups.backup.sourceTable).toEqual(genTableName);

            // Fresh ids per attempt; both land in the instance the stack destroys.
            const id = `gen-${yield* Effect.sync(() => crypto.randomUUID().slice(0, 8))}`;
            const copied = yield* expectProbe<{ name?: string }>(
              baseUrl,
              `copyBackup?backup=${encodeURIComponent(backupName)}&id=${id}`,
            );
            expect(copied.name).toContain(`${instanceName}/clusters/cluster/backups/${id}`);
            const restored = yield* expectProbe<{ name?: string }>(
              baseUrl,
              `restoreTable?backup=${encodeURIComponent(backupName)}&id=${id}`,
            );
            expect(restored.name).toContain(`${instanceName}/tables/${id}/`);
            // The copy blocks deleting the cluster on destroy: remove both out of band.
            // The copy is a long-running operation: retry until it can be deleted.
            yield* bigtable
              .deleteProjectsInstancesClustersBackups({
                name: `${instanceName}/clusters/cluster/backups/${id}`,
              })
              .pipe(
                Effect.retry({
                  while: (error) => error._tag === "BadRequest" || error._tag === "Conflict",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 24,
                }),
              );
            yield* bigtable
              .deleteProjectsInstancesTables({ name: `${instanceName}/tables/${id}` })
              .pipe(
                Effect.retry({
                  // The restore is still running for a few seconds.
                  while: (error) => error._tag === "BadRequest" || error._tag === "Conflict",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 24,
                }),
              );
            yield* expectInstanceGrants;
          }),
        live,
      );
    });

    describe("consumeInstanceAuditLogs / consumeTableAuditLogs", () => {
      test.provider(
        "deliver each resource's audit log entries to the host",
        (_stack) =>
          Effect.gen(function* () {
            // Admin Activity calls that change nothing (or only a description).
            const cases = [
              {
                key: "instance",
                name: instanceName,
                method: "SetIamPolicy",
                trigger: bigtable
                  .getIamPolicyProjectsInstances({ resource: instanceName, body: {} })
                  .pipe(
                    Effect.flatMap((policy) =>
                      bigtable.setIamPolicyProjectsInstances({
                        resource: instanceName,
                        body: { policy },
                      }),
                    ),
                  ),
              },
              {
                key: "table",
                name: genTableName,
                method: "SetIamPolicy",
                trigger: bigtable
                  .getIamPolicyProjectsInstancesTables({ resource: genTableName, body: {} })
                  .pipe(
                    Effect.flatMap((policy) =>
                      bigtable.setIamPolicyProjectsInstancesTables({
                        resource: genTableName,
                        body: { policy },
                      }),
                    ),
                  ),
              },
            ];
            for (const { key, name, method, trigger } of cases) {
              const entry = yield* expectAuditEntry({ bucket: auditMarkers, key, method, trigger });
              expect(entry.serviceName).toEqual("bigtableadmin.googleapis.com");
              // Audit logs may name the project by number.
              const path = (value: string) => value.replace(/^projects\/[^/]+/, "");
              expect(path(entry.resourceName)).toContain(path(name));
            }
          }),
        { tags: ["provider:gcp", "live"], timeout: 900_000 },
      );
    });
  },
);
