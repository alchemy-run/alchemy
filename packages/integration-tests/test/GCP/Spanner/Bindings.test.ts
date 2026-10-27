import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import { expectProbe } from "../bindingHost.ts";
import SpannerBindingsHost, {
  App,
  Db,
  Gen,
  GenBackup,
  GenSchedule,
  ITEMS_DDL,
  Schema,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SpannerBindings");

let baseUrl: string;
let member: string;
let names: {
  instance: string;
  schema: string;
  app: string;
  gen: string;
  backup: string;
  schedule: string;
};

/** What the generated instance-level bindings grant on the shared instance. */
const INSTANCE_ROLES = [
  "roles/spanner.backupWriter",
  "roles/spanner.databaseReader",
  "roles/spanner.editor",
  "roles/spanner.restoreAdmin",
  "roles/spanner.viewer",
];

type Policy = { bindings?: { role?: string; members?: string[] }[] };

const rolesOf = (policy: Policy) =>
  (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => binding.role)
    .sort();

const databaseRoles = (database: string) =>
  spanner
    .getIamPolicyProjectsInstancesDatabases({
      resource: database,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(Effect.map(rolesOf));

const instanceRoles = Effect.suspend(() =>
  spanner
    .getIamPolicyProjectsInstances({
      resource: names.instance,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(Effect.map(rolesOf)),
);

describe(
  "Spanner Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:spanner", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* SpannerBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              instance: (yield* Db).name,
              schema: (yield* Schema).name,
              app: (yield* App).name,
              gen: (yield* Gen).name,
              backup: (yield* GenBackup).name,
              schedule: (yield* GenSchedule).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        names = out;
      }),
      { timeout: 1_200_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 900_000 });

    describe("GetInstance", () => {
      test.provider(
        "reads the instance as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<spanner.Instance>(baseUrl, "getInstance");
            expect(live.name).toEqual(names.instance);
            expect(live.processingUnits).toEqual(100);
            expect(yield* instanceRoles).toEqual(INSTANCE_ROLES);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:spanner", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetDdl", () => {
      test.provider(
        "reads the schema, granted databaseReader on the database only",
        (_stack) =>
          Effect.gen(function* () {
            const ddl = yield* expectProbe<spanner.GetDatabaseDdlResponse>(baseUrl, "getDdl");
            expect(ddl.statements).toEqual([ITEMS_DDL]);

            const direct = yield* spanner.getDdlProjectsInstancesDatabases({
              database: names.schema,
            });
            expect(ddl.statements).toEqual(direct.statements);

            expect(yield* databaseRoles(names.schema)).toEqual(["roles/spanner.databaseReader"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:spanner", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ExecuteSql", () => {
      test.provider(
        "queries the database, granted databaseUser on the database only",
        (_stack) =>
          Effect.gen(function* () {
            const result = yield* expectProbe<spanner.ResultSet>(baseUrl, "executeSql");
            expect(result.metadata?.rowType?.fields?.[0]?.name).toEqual("n");
            expect(result.rows).toEqual([["0"]]);

            expect(yield* databaseRoles(names.app)).toEqual(["roles/spanner.databaseUser"]);
            // Nothing leaks onto the other database or the instance.
            expect(yield* databaseRoles(names.schema)).toEqual(["roles/spanner.databaseReader"]);
            expect(yield* instanceRoles).toEqual(INSTANCE_ROLES);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:spanner", "live"],
          timeout: 600_000,
        },
      );
    });

    const live = { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 600_000 };

    describe("GetDatabase / ListDatabaseRoles / UpdateDatabaseDdl / AddDatabaseSplitPoints / ChangeDatabaseQuorum", () => {
      test.provider(
        "reads and alters the database as the host, granted on the database only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              database: { name?: string; state?: string };
              roles: { databaseRoles?: { name?: string }[] };
            }>(baseUrl, "database");
            expect(out.database).toMatchObject({ name: names.gen, state: "READY" });
            expect(out.roles.databaseRoles?.map((r) => r.name?.split("/").at(-1))).toContain(
              "public",
            );

            const ddl = yield* expectProbe<{ name?: string }>(baseUrl, "updateDdl");
            expect(ddl.name).toContain(`${names.gen}/operations/`);
            yield* expectProbe(baseUrl, "addSplitPoints");
            expect(yield* expectProbe<string>(baseUrl, "changeQuorum")).not.toEqual("succeeded");
          }),
        live,
      );
    });

    describe("BatchCreateSessions / ListDatabaseSessions / GetDatabaseSession / BeginTransaction / ExecuteBatchDml / Commit / Rollback / Read / PartitionQuery / PartitionRead / DeleteDatabaseSession", () => {
      test.provider(
        "writes and reads rows through a session as the host, granted on the database only",
        (_stack) =>
          Effect.gen(function* () {
            const created = yield* expectProbe<{ session?: { name?: string }[] }>(
              baseUrl,
              "createSession",
            );
            const sessionName = created.session![0]!.name!;
            const session = sessionName.split("/").at(-1)!;
            expect(sessionName).toContain(`${names.gen}/sessions/`);
            const listed = yield* expectProbe<{ sessions?: { name?: string }[] }>(
              baseUrl,
              "listSessions",
            );
            expect(listed.sessions?.map((s) => s.name)).toContain(sessionName);
            expect(
              (yield* expectProbe<{ name?: string }>(baseUrl, `getSession?session=${session}`))
                .name,
            ).toEqual(sessionName);

            const written = yield* expectProbe<{
              dml: { resultSets?: { stats?: { rowCountExact?: string } }[] };
              commitTimestamp?: string;
            }>(baseUrl, `write?session=${session}`);
            expect(written.dml.resultSets?.[0]?.stats?.rowCountExact).toEqual("1");
            expect(written.commitTimestamp).toBeDefined();

            const rows = yield* expectProbe<{ rows?: string[][] }>(
              baseUrl,
              `read?session=${session}`,
            );
            expect(rows.rows).toEqual([["binding-item"]]);
            const partitions = yield* expectProbe<{
              query: { partitions?: unknown[] };
              read: { partitions?: unknown[] };
            }>(baseUrl, `partitions?session=${session}`);
            expect(partitions.query.partitions?.length).toBeGreaterThan(0);
            expect(partitions.read.partitions?.length).toBeGreaterThan(0);

            yield* expectProbe(baseUrl, `deleteSession?session=${session}`);
            const gone = yield* spanner
              .getProjectsInstancesDatabasesSessions({ name: sessionName })
              .pipe(Effect.flip);
            expect(gone._tag).toEqual("NotFound");

            expect(yield* databaseRoles(names.gen)).toEqual([
              "roles/spanner.databaseAdmin",
              "roles/spanner.databaseReader",
              "roles/spanner.databaseUser",
              "roles/spanner.viewer",
            ]);
          }),
        live,
      );
    });

    describe("ListDatabaseBackupSchedules / GetDatabaseBackupSchedule / GetInstanceBackup / ListInstanceBackups / ListInstanceBackupOperations", () => {
      test.provider(
        "reads backups and backup schedules as the host",
        (_stack) =>
          Effect.gen(function* () {
            const schedules = yield* expectProbe<{
              list: { backupSchedules?: { name?: string }[] };
              get: { name?: string };
            }>(baseUrl, "schedules");
            expect(schedules.list.backupSchedules?.map((b) => b.name)).toEqual([names.schedule]);
            expect(schedules.get.name).toEqual(names.schedule);

            const backups = yield* expectProbe<{
              backup: { name?: string; database?: string };
              list: { backups?: { name?: string }[] };
              operations: { operations?: unknown[] };
            }>(baseUrl, "backups");
            expect(backups.backup).toMatchObject({ name: names.backup, database: names.gen });
            expect(backups.list.backups?.map((b) => b.name)).toContain(names.backup);
            expect(backups.operations.operations?.length).toBeGreaterThan(0);

            const backupPolicy = yield* spanner.getIamPolicyProjectsInstancesBackups({
              resource: names.backup,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            expect(rolesOf(backupPolicy)).toEqual(["roles/spanner.viewer"]);
          }),
        live,
      );
    });

    describe("ListInstanceDatabases / ListInstanceDatabaseOperations / ListInstancePartitions / ListInstancePartitionOperations / GetInstancePartition / CopyInstanceBackup / RestoreInstanceDatabase / MoveInstance", () => {
      test.provider(
        "reads the instance's children as the host and is refused copies, restores and moves that can't apply",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              databases: { databases?: { name?: string }[] };
              missingPartition: string;
            }>(baseUrl, "instance");
            expect(out.databases.databases?.map((d) => d.name)).toEqual(
              expect.arrayContaining([names.schema, names.app, names.gen]),
            );
            expect(out.missingPartition).toEqual("NotFound");

            const refused = yield* expectProbe<Record<string, string>>(baseUrl, "refused");
            expect(refused.copy).toEqual("NotFound");
            expect(refused.restore).not.toEqual("succeeded");
            expect(refused.move).not.toEqual("succeeded");
            expect(yield* instanceRoles).toEqual(INSTANCE_ROLES);
          }),
        live,
      );
    });
  },
);
