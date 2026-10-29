import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { expectAuditEntry } from "../auditLogs.ts";
import { callProbe, expectProbe } from "../bindingHost.ts";
import StorageBindingsHost, {
  AuditMarkers,
  FolderAssets,
  GEN_PART,
  GEN_RESTORE,
  GEN_SEED,
  GenAssets,
  GenHmacKey,
  ManagedAssets,
  DeleteAssets,
  GetAssets,
  PutAssets,
  ReadAssets,
  ReadWriteAssets,
  SEED_KEY,
  SEED_TEXT,
  SignAssets,
  WriteAssets,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "StorageBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let buckets: {
  read: string;
  write: string;
  readWrite: string;
  get: string;
  put: string;
  delete: string;
  sign: string;
};
let gen: {
  assets: string;
  managed: string;
  folders: string;
  hmacAccessId: string;
  markers: string;
};

/** Every project-level role the host's service account holds. */
const projectRoles = () =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
          .map((binding) => binding.role)
          .sort(),
      ),
    );

/** Roles the host's service account holds on one bucket's IAM policy. */
const bucketRoles = (bucket: string) =>
  storage.getIamPolicyBuckets({ bucket, optionsRequestedPolicyVersion: 3 }).pipe(
    Effect.map((policy) =>
      (policy.bindings ?? [])
        .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
        .map((binding) => binding.role)
        .sort(),
    ),
  );

const objectOf = (bucket: string, object: string) =>
  storage
    .getObjects({ bucket, object })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

describe(
  "Storage Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:storage", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* StorageBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              read: (yield* ReadAssets).bucketName,
              write: (yield* WriteAssets).bucketName,
              readWrite: (yield* ReadWriteAssets).bucketName,
              get: (yield* GetAssets).bucketName,
              put: (yield* PutAssets).bucketName,
              delete: (yield* DeleteAssets).bucketName,
              sign: (yield* SignAssets).bucketName,
              gen: {
                assets: (yield* GenAssets).bucketName,
                managed: (yield* ManagedAssets).bucketName,
                folders: (yield* FolderAssets).bucketName,
                hmacAccessId: (yield* GenHmacKey).accessId,
                markers: (yield* AuditMarkers).bucketName,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        buckets = {
          read: out.read,
          write: out.write,
          readWrite: out.readWrite,
          get: out.get,
          put: out.put,
          delete: out.delete,
          sign: out.sign,
        };
        gen = out.gen;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("ReadBucket", () => {
      test.provider(
        "head, get and list as the host, with objectViewer on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              headName: string;
              headSize: string;
              text: string;
              contentType: string;
              listed: string[];
              missingHead: boolean;
              missingGet: boolean;
            }>(baseUrl, "readBucket");
            expect(out.headName).toEqual(SEED_KEY);
            expect(out.headSize).toEqual(String(SEED_TEXT.length));
            expect(out.text).toEqual(SEED_TEXT);
            expect(out.contentType).toEqual("text/plain");
            expect(out.listed).toEqual([SEED_KEY]);
            expect(out.missingHead).toEqual(true);
            expect(out.missingGet).toEqual(true);

            expect(yield* bucketRoles(buckets.read)).toEqual(["roles/storage.objectViewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteBucket", () => {
      test.provider(
        "put and delete as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const put = yield* expectProbe<{ name: string }>(baseUrl, "writeBucketPut");
            expect(put.name).toEqual("written.txt");
            const written = yield* objectOf(buckets.write, "written.txt");
            expect(written?.size).toEqual(String("hello from WriteBucket".length));
            expect(written?.contentType).toEqual("text/plain");
            expect(written?.metadata).toEqual({ source: "write-bucket" });

            const deleted = yield* expectProbe<{ deleted: string }>(baseUrl, "writeBucketDelete");
            expect(deleted.deleted).toEqual("written.txt");
            expect(yield* objectOf(buckets.write, "written.txt")).toEqual(undefined);

            expect(yield* bucketRoles(buckets.write)).toEqual(["roles/storage.objectUser"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadWriteBucket", () => {
      test.provider(
        "put, get, list and delete as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              putName: string;
              text: string;
              listed: string[];
            }>(baseUrl, "readWriteBucket");
            expect(out.putName).toEqual("round-trip.txt");
            expect(out.text).toEqual("hello from ReadWriteBucket");
            expect(out.listed).toEqual(["round-trip.txt"]);
            const written = yield* objectOf(buckets.readWrite, "round-trip.txt");
            expect(written?.size).toEqual(String("hello from ReadWriteBucket".length));

            const deleted = yield* expectProbe<{ gone: boolean }>(baseUrl, "readWriteBucketDelete");
            expect(deleted.gone).toEqual(true);
            expect(yield* objectOf(buckets.readWrite, "round-trip.txt")).toEqual(undefined);

            expect(yield* bucketRoles(buckets.readWrite)).toEqual(["roles/storage.objectUser"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetObject", () => {
      test.provider(
        "downloads the seeded object as the host, with objectViewer on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              text: string;
              contentType: string;
            }>(baseUrl, "getObject");
            expect(out.text).toEqual(SEED_TEXT);
            expect(out.contentType).toEqual("text/plain");

            const missing = yield* callProbe(baseUrl, "getObjectMissing");
            expect(missing.ok ? undefined : missing.error._tag).toEqual(
              "GCP.Storage.ObjectNotFound",
            );

            expect(yield* bucketRoles(buckets.get)).toEqual(["roles/storage.objectViewer"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("PutObject", () => {
      test.provider(
        "uploads bytes with metadata as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              name: string;
              metadata: Record<string, string>;
            }>(baseUrl, "putObject");
            expect(out.name).toEqual("put.bin");
            expect(out.metadata).toEqual({ source: "put-object" });

            const written = yield* objectOf(buckets.put, "put.bin");
            expect(written?.size).toEqual(String("hello from PutObject".length));
            expect(written?.contentType).toEqual("application/octet-stream");
            expect(written?.metadata).toEqual({ source: "put-object" });

            expect(yield* bucketRoles(buckets.put)).toEqual(["roles/storage.objectUser"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("DeleteObject", () => {
      test.provider(
        "deletes the seeded object as the host, with objectUser on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            const seed = yield* objectOf(buckets.delete, SEED_KEY);
            expect(seed?.name).toEqual(SEED_KEY);

            const out = yield* expectProbe<{ deleted: string }>(baseUrl, "deleteObject");
            expect(out.deleted).toEqual(SEED_KEY);
            expect(yield* objectOf(buckets.delete, SEED_KEY)).toEqual(undefined);

            const missing = yield* callProbe(baseUrl, "deleteObjectMissing");
            expect(missing.ok ? undefined : missing.error._tag).toEqual("NotFound");

            expect(yield* bucketRoles(buckets.delete)).toEqual(["roles/storage.objectUser"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("SignGetObjectUrl", () => {
      test.provider(
        "mints a V4 URL that downloads without credentials; grants objectViewer on the bucket and tokenCreator on the host's own account",
        (_stack) =>
          Effect.gen(function* () {
            const { url } = yield* expectProbe<{ url: string }>(baseUrl, "signGetObjectUrl");
            expect(url).toContain(`https://storage.googleapis.com/${buckets.sign}/seed/hello.txt?`);
            expect(url).toContain(`X-Goog-Credential=${encodeURIComponent(hostAccount)}`);

            // No credentials: the signature alone authorizes the download.
            // The signer's bucket grant may still be propagating.
            const body = yield* HttpClient.get(url).pipe(
              Effect.flatMap((response) =>
                response.status === 200
                  ? response.text
                  : Effect.fail(new Error(`HTTP ${response.status}`)),
              ),
              Effect.retry({
                schedule: Schedule.spaced("5 seconds"),
                times: 24,
              }),
            );
            expect(body).toEqual(SEED_TEXT);

            expect(yield* bucketRoles(buckets.sign)).toEqual(["roles/storage.objectViewer"]);
            const accountPolicy = yield* iam.getIamPolicyProjectsServiceAccounts({
              resource: `projects/${project}/serviceAccounts/${hostAccount}`,
            });
            expect(
              (accountPolicy.bindings ?? [])
                .filter((binding) =>
                  (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
                )
                .map((binding) => binding.role),
            ).toEqual(["roles/iam.serviceAccountTokenCreator"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storage", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("generated bucket bindings", () => {
      test.provider(
        "reads the bucket, its ACLs, notifications and caches, granted on the bucket only",
        (_stack) =>
          Effect.gen(function* () {
            // Concurrently: a probe still refused when the others finish
            // is the one missing a permission.
            const out = yield* Effect.all(
              {
                bucket: expectProbe<storage.Bucket>(baseUrl, "getBucket"),
                layout: expectProbe<storage.BucketStorageLayout>(baseUrl, "getLayout"),
                bucketAcls: expectProbe<storage.BucketAccessControls>(baseUrl, "listBucketAcls"),
                defaultAcls: expectProbe<storage.ObjectAccessControls>(baseUrl, "listDefaultAcls"),
                objectAcls: expectProbe<storage.ObjectAccessControls>(baseUrl, "listObjectAcls"),
                notifications: expectProbe<storage.Notifications>(baseUrl, "listNotifications"),
                caches: expectProbe<storage.AnywhereCaches>(baseUrl, "listCaches"),
              },
              { concurrency: "unbounded" },
            );
            expect(out.bucket.name).toEqual(gen.assets);
            expect(out.layout.bucket).toEqual(gen.assets);
            expect((out.bucketAcls.items ?? []).length).toBeGreaterThan(0);
            expect((out.defaultAcls.items ?? []).length).toBeGreaterThan(0);
            expect((out.objectAcls.items ?? []).length).toBeGreaterThan(0);
            expect(out.notifications.items ?? []).toEqual([]);
            expect(out.caches.items ?? []).toEqual([]);
            const refusals = [
              "missingBucketAcl",
              "missingDefaultAcl",
              "missingObjectAcl",
              "missingNotification",
              "missingCache",
              "updateMissingCache",
              "pauseMissingCache",
              "resumeMissingCache",
              "disableMissingCache",
              "restoreLiveBucket",
              "missingContext",
            ];
            const outcomes = yield* Effect.forEach(
              refusals,
              (name) => expectProbe<string>(baseUrl, name).pipe(Effect.map((tag) => [name, tag])),
              { concurrency: "unbounded" },
            );
            expect(Object.fromEntries(outcomes)).toEqual(
              Object.fromEntries(refusals.map((name) => [name, "NotFound"])),
            );
          }),
        { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 600_000 },
      );

      test.provider(
        "inserts, composes, copies, rewrites, patches and updates objects",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              composed: string;
              copied: string;
              rewritten: boolean;
              patched: Record<string, string>;
              updated: Record<string, string>;
            }>(baseUrl, `genObjects?bucket=${gen.assets}`);
            expect(out).toMatchObject({
              composed: "gen/composed.txt",
              copied: "gen/copied.txt",
              rewritten: true,
              updated: { updated: "yes" },
            });
            // A patch merges into the object's existing metadata.
            expect(out.patched.patched).toEqual("yes");
            expect((yield* objectOf(gen.assets, "gen/composed.txt"))?.size).toEqual(
              String("seed;part;".length),
            );
            expect((yield* objectOf(gen.assets, "gen/rewritten.txt"))?.size).toEqual(
              String("seed;".length),
            );
            expect((yield* objectOf(gen.assets, GEN_PART))?.contentType).toEqual("text/plain");
            expect(yield* objectOf(gen.assets, GEN_SEED)).toBeDefined();
          }),
        { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 600_000 },
      );

      test.provider(
        "restores a soft-deleted object, and starts a bulk restore",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* storage.getObjects({ bucket: gen.assets, object: GEN_RESTORE });
            yield* storage.deleteObjects({ bucket: gen.assets, object: GEN_RESTORE });
            const out = yield* expectProbe<{ restored: string; bulk: boolean }>(
              baseUrl,
              `genRestore?generation=${live.generation}`,
            );
            expect(out).toEqual({ restored: GEN_RESTORE, bulk: true });
            expect((yield* objectOf(gen.assets, GEN_RESTORE))?.size).toEqual(
              String("restore;".length),
            );
          }),
        { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 600_000 },
      );
    });

    describe("generated folder bindings", () => {
      test.provider(
        "reads managed folders, and gets, lists, renames and drops folders",
        (_stack) =>
          Effect.gen(function* () {
            const managed = yield* expectProbe<{
              folder: storage.ManagedFolder;
              list: storage.ManagedFolders;
            }>(baseUrl, "managed");
            expect(managed.folder.name).toEqual("managed/");
            expect((managed.list.items ?? []).map((folder) => folder.name)).toEqual(["managed/"]);
            expect(yield* bucketRoles(gen.managed)).toEqual(["roles/storage.legacyBucketReader"]);

            const folders = yield* expectProbe<{
              kept: string;
              listed: string[];
              renamed: boolean;
              dropped: string;
              moved: string;
            }>(baseUrl, "folders");
            expect(folders.kept).toEqual("keep/");
            expect(folders.listed).toContain("keep/");
            expect(folders).toMatchObject({
              renamed: true,
              dropped: "BadRequest",
              moved: "keep/moved.txt",
            });
            expect(yield* objectOf(gen.folders, "keep/moved.txt")).toBeDefined();
            expect(yield* objectOf(gen.folders, "keep/source.txt")).toBeUndefined();
            expect(yield* bucketRoles(gen.folders)).toEqual([
              "roles/storage.legacyBucketReader",
              "roles/storage.legacyBucketWriter",
              "roles/storage.objectUser",
            ]);
          }),
        { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 600_000 },
      );
    });

    describe("generated project bindings", () => {
      test.provider(
        "reads an HMAC key and lists keys and buckets in the project",
        (_stack) =>
          Effect.gen(function* () {
            const hmac = yield* expectProbe<{ accessId: string; listed: string[] }>(
              baseUrl,
              "hmac",
            );
            expect(hmac).toEqual({ accessId: gen.hmacAccessId, listed: [gen.hmacAccessId] });
            const listed = yield* expectProbe<string[]>(baseUrl, `buckets?prefix=${gen.assets}`);
            expect(listed).toEqual([gen.assets]);

            expect(yield* bucketRoles(gen.assets)).toEqual([
              "roles/storage.bucketViewer",
              "roles/storage.legacyBucketOwner",
              "roles/storage.legacyObjectOwner",
              "roles/storage.objectUser",
              "roles/storage.objectViewer",
            ]);
            // HMAC keys and soft-deleted buckets have no IAM policy of their own.
            expect(yield* projectRoles()).toEqual([
              "roles/storage.admin",
              "roles/storage.bucketViewer",
              "roles/storage.viewer",
            ]);
          }),
        { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 600_000 },
      );
    });

    describe("audit logs", () => {
      test.provider(
        "delivers the bucket's audit entries",
        (_stack) =>
          Effect.gen(function* () {
            const entry = yield* expectAuditEntry({
              bucket: gen.markers,
              key: "bucket",
              method: "",
              trigger: storage.patchBuckets({
                bucket: gen.assets,
                body: { labels: { audited: "yes" } },
              }),
            });
            expect(entry.serviceName).toEqual("storage.googleapis.com");
            expect(entry.resourceName).toEqual(`projects/_/buckets/${gen.assets}`);
          }),
        { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 900_000 },
      );
    });
  },
);
