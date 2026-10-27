import * as GCP from "@alchemy.run/gcp";
import { decodeFields, encodeFields } from "@alchemy.run/gcp/Firestore/Values";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectAuditEntry } from "../auditLogs.ts";
import { expectProbe } from "../bindingHost.ts";
import FirestoreBindingsHost, {
  AuditMarkers,
  DocsDatabase,
  EnterpriseDatabase,
  GenDatabase,
  PATCHED,
  ReadOnlyDatabase,
  ReadWriteOnlyDatabase,
  SEEDED_DELETE,
  SEEDED_GET,
  WriteOnlyDatabase,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "FirestoreBindings");

let baseUrl: string;
let auditMarkers: string;
let hostAccount: string;
let project: string;
let databases: {
  docs: string;
  readOnly: string;
  writeOnly: string;
  readWrite: string;
  gen: string;
  enterprise: string;
};

/** Write a document out of band, as the deployer. */
const seed = (database: string, path: string, fields: Record<string, unknown>) =>
  firestore.patchProjectsDatabasesDocuments({
    name: `${database}/documents/${path}`,
    body: { fields: encodeFields(fields) },
  });

/** Read a document's fields out of band, `undefined` when it is missing. */
const readOutOfBand = (database: string, path: string) =>
  firestore.getProjectsDatabasesDocuments({ name: `${database}/documents/${path}` }).pipe(
    Effect.map((document) => decodeFields(document.fields)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/**
 * Roles the host holds on the project under the IAM Condition naming only
 * `database` (Firestore has no per-database IAM policy). Also asserts the
 * host's only unconditioned project roles are the user-credential ones.
 */
const scopedRoles = (database: string) =>
  Effect.gen(function* () {
    const policy = yield* crm.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    const hostBindings = (policy.bindings ?? []).filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    );
    // Only the user-credential bindings grant on the whole project: IAM
    // Conditions don't match individual credentials.
    expect(
      hostBindings
        .filter((binding) => binding.condition === undefined)
        .map((binding) => binding.role)
        .sort(),
    ).toEqual(["roles/datastore.userCredsAdmin", "roles/datastore.userCredsViewer"]);
    const condition = `resource.name == "${database}" || resource.name.startsWith("${database}/")`;
    return hostBindings
      .filter((binding) => binding.condition?.expression === condition)
      .map((binding) => binding.role)
      .sort();
  });

describe.skipIf(!!process.env.FAST)(
  "Firestore Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:firestore", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* FirestoreBindingsHost;
            const docs = yield* DocsDatabase;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              auditMarkers: (yield* AuditMarkers).bucketName,
              project: docs.project,
              docs: docs.name,
              readOnly: (yield* ReadOnlyDatabase).name,
              writeOnly: (yield* WriteOnlyDatabase).name,
              readWrite: (yield* ReadWriteOnlyDatabase).name,
              gen: (yield* GenDatabase).name,
              enterprise: (yield* EnterpriseDatabase).name,
            };
          }),
        );
        baseUrl = out.uri!;
        auditMarkers = out.auditMarkers;
        hostAccount = out.serviceAccount!;
        project = out.project;
        databases = {
          docs: out.docs,
          readOnly: out.readOnly,
          writeOnly: out.writeOnly,
          readWrite: out.readWrite,
          gen: out.gen,
          enterprise: out.enterprise,
        };
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    const live = {
      tags: ["provider:gcp", "provider:gcp:firestore", "live"],
      timeout: 600_000,
    };

    const expectDocsGrants = Effect.suspend(() => scopedRoles(databases.docs)).pipe(
      Effect.map((roles) =>
        expect(roles).toEqual(["roles/datastore.user", "roles/datastore.viewer"]),
      ),
    );

    describe("PatchDocument", () => {
      test.provider(
        "writes a document as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            const doc = yield* expectProbe<firestore.Document>(baseUrl, "patchDocument");
            expect(doc.name).toEqual(`${databases.docs}/documents/${PATCHED}`);
            expect(yield* readOutOfBand(databases.docs, PATCHED)).toEqual({
              name: "Alice",
            });
            yield* expectDocsGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetDocument", () => {
      test.provider(
        "reads a seeded document as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed(databases.docs, SEEDED_GET, { name: "Seeded" });
            const doc = yield* expectProbe<firestore.Document>(baseUrl, "getDocument");
            expect(doc.fields?.name?.stringValue).toEqual("Seeded");
            yield* expectDocsGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("DeleteDocument", () => {
      test.provider(
        "deletes a seeded document as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed(databases.docs, SEEDED_DELETE, { name: "Doomed" });
            yield* expectProbe(baseUrl, "deleteDocument");
            expect(yield* readOutOfBand(databases.docs, SEEDED_DELETE)).toBeUndefined();
            yield* expectDocsGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadDatabase", () => {
      test.provider(
        "gets, lists and queries seeded documents, granted datastore.viewer under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed(databases.readOnly, "things/a", { n: 1, s: "a" });
            yield* seed(databases.readOnly, "things/b", { n: 2, s: "b" });
            const out = yield* expectProbe(baseUrl, "read");
            expect(out).toEqual({
              one: { n: 1, s: "a" },
              missing: true,
              listed: ["a", "b"],
              hasNextPage: true,
              big: [2],
            });
            expect(yield* scopedRoles(databases.readOnly)).toEqual(["roles/datastore.viewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteDatabase", () => {
      test.provider(
        "creates, updates, sets and deletes documents, granted datastore.user under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe(baseUrl, "write");
            expect(out).toEqual({
              created: true,
              conflict: "things/created",
              updated: { n: 1, "odd key": "x" },
              updateMissing: "NotFound",
            });
            expect(yield* readOutOfBand(databases.writeOnly, "things/created")).toEqual({
              n: 1,
              "odd key": "x",
            });
            expect(yield* readOutOfBand(databases.writeOnly, "things/set")).toEqual({
              team: "red",
            });
            expect(yield* readOutOfBand(databases.writeOnly, "things/gone")).toBeUndefined();
            expect(yield* scopedRoles(databases.writeOnly)).toEqual(["roles/datastore.user"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadWriteDatabase", () => {
      test.provider(
        "round-trips documents, granted datastore.user under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe(baseUrl, "readWrite");
            expect(out).toEqual({
              missing: true,
              b: { team: "blue", n: 3 },
              listed: ["a", "b"],
              red: ["a"],
              afterDelete: true,
            });
            expect(yield* readOutOfBand(databases.readWrite, "scores/b")).toEqual({
              team: "blue",
              n: 3,
            });
            expect(yield* readOutOfBand(databases.readWrite, "scores/a")).toBeUndefined();
            expect(yield* scopedRoles(databases.readWrite)).toEqual(["roles/datastore.user"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firestore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetDatabase / Commit / BatchGetDocuments / BatchWriteDocuments / BeginTransaction / Rollback / ListDocuments / ListCollectionIds / RunAggregationQuery / PartitionQuery / ExecutePipeline", () => {
      test.provider(
        "writes, reads and queries documents as the host, under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            const database = yield* expectProbe<{ name?: string; type?: string }>(
              baseUrl,
              "getDatabase",
            );
            expect(database).toMatchObject({ name: databases.gen, type: "FIRESTORE_NATIVE" });

            const committed = yield* expectProbe<{ writeResults?: unknown[] }>(baseUrl, "commit");
            expect(committed.writeResults).toHaveLength(2);
            const got = yield* expectProbe<{ found?: { name?: string } }[]>(baseUrl, "batchGet");
            expect(got.map((r) => r.found?.name).sort()).toEqual(
              ["a", "b"].map((id) => `${databases.gen}/documents/gen/${id}`),
            );
            const written = yield* expectProbe<{ status?: unknown[] }>(baseUrl, "batchWrite");
            expect(written.status).toHaveLength(1);
            expect(yield* readOutOfBand(databases.gen, "gen/c")).toEqual({ n: 3 });
            expect(yield* expectProbe(baseUrl, "transaction")).toEqual({ transaction: true });

            const listed = yield* expectProbe<{ documents?: { name?: string }[] }>(
              baseUrl,
              "listDocuments",
            );
            expect(listed.documents).toHaveLength(3);
            expect(
              yield* expectProbe<{ collectionIds?: string[] }>(baseUrl, "listCollectionIds"),
            ).toEqual({ collectionIds: ["gen"] });
            const counted = yield* expectProbe<
              { result?: { aggregateFields?: Record<string, { integerValue?: string }> } }[]
            >(baseUrl, "count");
            expect(counted[0]?.result?.aggregateFields?.total?.integerValue).toEqual("3");
            yield* expectProbe(baseUrl, "partitionQuery");
            expect(yield* expectProbe<string>(baseUrl, "executePipeline")).not.toEqual("Forbidden");

            expect(yield* scopedRoles(databases.gen)).toEqual(
              expect.arrayContaining(["roles/datastore.user"]),
            );
          }),
        live,
      );
    });

    describe("BulkDeleteDocuments / ExportDocuments / ImportDocuments", () => {
      test.provider(
        "starts admin operations as the host, under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            const bulk = yield* expectProbe<{ name?: string }>(baseUrl, "bulkDelete");
            expect(bulk.name).toContain("/operations/");
            // The bucket doesn't exist: both calls are authorized and fail on it.
            const out = yield* expectProbe<{ export: string; import: string }>(
              baseUrl,
              "exportImport",
            );
            expect(out.export).not.toEqual("Forbidden");
            expect(out.import).not.toEqual("Forbidden");
          }),
        live,
      );
    });

    describe("CreateDatabaseCollectionGroupIndex / ListDatabaseCollectionGroupIndexes / GetDatabaseCollectionGroupIndex / DeleteDatabaseCollectionGroupIndex / GetDatabaseCollectionGroupField / ListDatabaseCollectionGroupFields / PatchDatabaseCollectionGroupField", () => {
      test.provider(
        "manages a composite index and a TTL field as the host, under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            expect(yield* expectProbe<string>(baseUrl, "createIndex")).not.toEqual("Forbidden");
            const listed = yield* expectProbe<{ indexes?: { name?: string }[] }>(
              baseUrl,
              "listIndexes",
            );
            const name = listed.indexes?.[0]?.name;
            expect(name).toContain(`${databases.gen}/collectionGroups/gen/indexes/`);
            const index = name!.split("/").at(-1)!;
            // Building takes minutes; the index is readable (and deletable) while it builds.
            const got = yield* expectProbe<{ name?: string; state?: string }>(
              baseUrl,
              `getIndex?index=${index}`,
            );
            expect(got.name).toEqual(name);
            expect(["CREATING", "READY"]).toContain(got.state);
            yield* expectProbe(baseUrl, `deleteIndex?index=${index}`);

            const fields = yield* expectProbe<{ default: { name?: string } }>(baseUrl, "fields");
            expect(fields.default.name).toEqual(
              `${databases.gen}/collectionGroups/__default__/fields/*`,
            );
            const ttl = yield* expectProbe<{ name?: string }>(baseUrl, "patchField");
            expect(ttl.name).toContain("/operations/");
          }),
        live,
      );
    });

    describe("CreateDatabaseBackupSchedule / ListDatabaseBackupSchedules / GetDatabaseBackupSchedule / PatchDatabaseBackupSchedule / DeleteDatabaseBackupSchedule", () => {
      test.provider(
        "manages a daily backup schedule as the host, under the database condition",
        (_stack) =>
          Effect.gen(function* () {
            const created = yield* expectProbe<{ name?: string; retention?: string }>(
              baseUrl,
              "createSchedule",
            );
            expect(created.retention).toEqual("604800s");
            const schedule = created.name!.split("/").at(-1)!;
            const listed = yield* expectProbe<{ backupSchedules?: { name?: string }[] }>(
              baseUrl,
              "listSchedules",
            );
            expect(listed.backupSchedules?.map((b) => b.name)).toEqual([created.name]);
            expect(
              (yield* expectProbe<{ name?: string }>(baseUrl, `getSchedule?schedule=${schedule}`))
                .name,
            ).toEqual(created.name);
            expect(
              (yield* expectProbe<{ retention?: string }>(
                baseUrl,
                `patchSchedule?schedule=${schedule}`,
              )).retention,
            ).toEqual("1209600s");
            yield* expectProbe(baseUrl, `deleteSchedule?schedule=${schedule}`);
          }),
        live,
      );
    });

    describe("CreateDatabaseUserCred / ListDatabaseUserCreds / GetDatabaseUserCred / EnableDatabaseUserCred / DisableDatabaseUserCred / ResetUserCredPassword / DeleteDatabaseUserCred", () => {
      test.provider(
        "manages a credential on an Enterprise database as the host",
        (_stack) =>
          Effect.gen(function* () {
            // A fresh id per attempt, so a retried test never collides with its own credential.
            const id = `binding-${yield* Effect.sync(() => crypto.randomUUID().slice(0, 8))}`;
            const name = `${databases.enterprise}/userCreds/${id}`;
            // One probe per call: a probe retried while IAM propagates must not re-create.
            const call = <A>(probe: string) => expectProbe<A>(baseUrl, `${probe}?id=${id}`);
            expect(yield* call<{ name?: string; state?: string }>("createUserCred")).toMatchObject({
              name,
              state: "ENABLED",
            });
            const listed = yield* call<{ userCreds?: { name?: string }[] }>("listUserCreds");
            expect(listed.userCreds?.map((c) => c.name)).toContain(name);
            expect((yield* call<{ name?: string }>("getUserCred")).name).toEqual(name);
            expect((yield* call<{ state?: string }>("disableUserCred")).state).toEqual("DISABLED");
            expect((yield* call<{ state?: string }>("enableUserCred")).state).toEqual("ENABLED");
            expect(
              (yield* call<{ securePassword?: string }>("resetUserCred")).securePassword,
            ).toBeDefined();
            yield* call("deleteUserCred");
            // Create and list are checked on the database; the rest on the project.
            expect(yield* scopedRoles(databases.enterprise)).toEqual([
              "roles/datastore.userCredsAdmin",
              "roles/datastore.userCredsViewer",
            ]);

            expect(yield* scopedRoles(databases.gen)).toEqual([
              "roles/datastore.backupSchedulesAdmin",
              "roles/datastore.backupSchedulesViewer",
              "roles/datastore.bulkAdmin",
              "roles/datastore.importExportAdmin",
              "roles/datastore.indexAdmin",
              "roles/datastore.user",
              "roles/datastore.viewer",
            ]);
          }),
        live,
      );
    });

    describe("consumeDatabaseAuditLogs", () => {
      test.provider(
        "deliver each resource's audit log entries to the host",
        (_stack) =>
          Effect.gen(function* () {
            // Admin Activity calls that change nothing (or only a description).
            const cases = [
              {
                key: "database",
                name: databases.gen,
                method: "UpdateDatabase",
                trigger: firestore.patchProjectsDatabases({
                  name: databases.gen,
                  updateMask: "deleteProtectionState",
                  body: { deleteProtectionState: "DELETE_PROTECTION_DISABLED" },
                }),
              },
            ];
            for (const { key, name, method, trigger } of cases) {
              const entry = yield* expectAuditEntry({ bucket: auditMarkers, key, method, trigger });
              expect(entry.serviceName).toEqual("firestore.googleapis.com");
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
