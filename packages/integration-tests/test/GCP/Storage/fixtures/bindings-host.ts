import * as GCP from "@alchemy.run/gcp";
import { ObjectRequestFailed } from "@alchemy.run/gcp/Storage/ObjectMedia";
import type { Input } from "alchemy/Input";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordAuditLogs } from "../../auditLogs.ts";
import { outcome, probeParam, serveProbes } from "../../bindingHost.ts";

/** Object key and content seeded into the read-side buckets. */
export const SEED_KEY = "seed/hello.txt";
export const SEED_TEXT = "hello from the seed object";

/**
 * One bucket per binding, so each bucket's IAM policy shows exactly the
 * role that binding grants.
 */
const bucket = (id: string) =>
  GCP.Storage.Bucket(id, { location: "US-CENTRAL1", forceDestroy: true });

const seeded = (id: string) =>
  Effect.gen(function* () {
    const target = yield* bucket(id);
    yield* GCP.Storage.Object(`${id}Seed`, {
      bucketName: target.bucketName,
      key: SEED_KEY,
      content: SEED_TEXT,
      contentType: "text/plain",
    });
    return target;
  });

export const ReadAssets = seeded("ReadAssets");
export const WriteAssets = bucket("WriteAssets");
export const ReadWriteAssets = bucket("ReadWriteAssets");
export const GetAssets = seeded("GetAssets");
export const PutAssets = bucket("PutAssets");
export const DeleteAssets = seeded("DeleteAssets");
export const SignAssets = seeded("SignAssets");

/** Objects the generated object bindings compose, copy, patch and restore. */
export const GEN_SEED = "gen/seed.txt";
export const GEN_PART = "gen/part.txt";
export const GEN_RESTORE = "gen/restore.txt";

const object = (id: string, bucketName: Input<string>, key: string, content: string) =>
  GCP.Storage.Object(id, { bucketName, key, content, contentType: "text/plain" });

/** Fine-grained (ACL) bucket the generated bucket and object bindings bind. */
export const GenAssets = Effect.gen(function* () {
  const target = yield* GCP.Storage.Bucket("GenAssets", {
    location: "US-CENTRAL1",
    forceDestroy: true,
    uniformBucketLevelAccess: false,
  });
  yield* object("GenSeed", target.bucketName, GEN_SEED, "seed;");
  yield* object("GenPart", target.bucketName, GEN_PART, "part;");
  yield* object("GenRestore", target.bucketName, GEN_RESTORE, "restore;");
  return target;
});

/** Uniform-access bucket with a managed folder. */
export const ManagedAssets = Effect.gen(function* () {
  const target = yield* GCP.Storage.Bucket("ManagedAssets", {
    location: "US-CENTRAL1",
    forceDestroy: true,
    uniformBucketLevelAccess: true,
  });
  yield* GCP.Storage.Managed("GenManaged", {
    bucketName: target.bucketName,
    managedFolderName: "managed/",
  });
  return target;
});

/** Hierarchical-namespace bucket: folders, and atomic moves. */
export const FolderAssets = Effect.gen(function* () {
  const target = yield* GCP.Storage.Bucket("FolderAssets", {
    location: "US-CENTRAL1",
    forceDestroy: true,
    hierarchicalNamespace: true,
  });
  for (const [id, folderName] of [
    ["KeepFolder", "keep/"],
    ["RenameFolder", "rename-me/"],
    ["DropFolder", "drop/"],
  ] as const) {
    yield* GCP.Storage.Folder(id, { bucketName: target.bucketName, folderName });
  }
  yield* object("MoveSource", target.bucketName, "keep/source.txt", "move me");
  return target;
});

/** An HMAC key, for its service account, that GetHmacKey reads. */
export const GenHmacKey = Effect.gen(function* () {
  const owner = yield* GCP.IAM.ServiceAccount("HmacOwner", {});
  return yield* GCP.Storage.HmacKey("GenHmacKey", { serviceAccountEmail: owner.email });
});

/** Bucket the audit-log consumer records entries in. */
export const AuditMarkers = bucket("AuditMarkers");

/**
 * A 403 from the media endpoints: the fresh bucket grant has not
 * propagated yet (`callProbe` retries on this tag).
 */
class Forbidden extends Data.TaggedError("Forbidden")<{ message: string }> {}

const forbiddenAsTag = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof ObjectRequestFailed && error.status === 403
        ? new Forbidden({ message: error.message })
        : error,
    ),
  );

const text = (body: Uint8Array) => new TextDecoder().decode(body);

/**
 * Effect-native Cloud Run service exercising every Cloud Storage binding
 * as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class StorageBindingsHost extends GCP.Function<StorageBindingsHost>()(
  "StorageBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const readBucket = yield* GCP.Storage.ReadBucket(ReadAssets);
    const writeBucket = yield* GCP.Storage.WriteBucket(WriteAssets);
    const readWriteBucket = yield* GCP.Storage.ReadWriteBucket(ReadWriteAssets);
    const getObject = yield* GCP.Storage.GetObject(GetAssets);
    const putObject = yield* GCP.Storage.PutObject(PutAssets);
    const deleteObject = yield* GCP.Storage.DeleteObject(DeleteAssets);
    const signGetObjectUrl = yield* GCP.Storage.SignGetObjectUrl(SignAssets);

    const S = GCP.Storage;
    const getBucket = yield* S.GetBucket(GenAssets);
    const getLayout = yield* S.GetBucketStorageLayout(GenAssets);
    const listBucketAcls = yield* S.ListBucketAccessControls(GenAssets);
    const getBucketAcl = yield* S.GetBucketAccessControl(GenAssets);
    const listDefaultAcls = yield* S.ListDefaultObjectAccessControls(GenAssets);
    const getDefaultAcl = yield* S.GetDefaultObjectAccessControl(GenAssets);
    const listObjectAcls = yield* S.ListObjectAccessControls(GenAssets);
    const getObjectAcl = yield* S.GetObjectAccessControl(GenAssets);
    const listNotifications = yield* S.ListNotifications(GenAssets);
    const getNotification = yield* S.GetNotification(GenAssets);
    const listCaches = yield* S.ListAnywhereCaches(GenAssets);
    const getCache = yield* S.GetAnywhereCache(GenAssets);
    const updateCache = yield* S.UpdateAnywhereCache(GenAssets);
    const pauseCache = yield* S.PauseAnywhereCache(GenAssets);
    const resumeCache = yield* S.ResumeAnywhereCache(GenAssets);
    const disableCache = yield* S.DisableAnywhereCache(GenAssets);
    const composeObject = yield* S.ComposeObject(GenAssets);
    const copyObject = yield* S.CopyObject(GenAssets);
    const rewriteObject = yield* S.RewriteObject(GenAssets);
    const patchObject = yield* S.PatchObject(GenAssets);
    const updateObject = yield* S.UpdateObject(GenAssets);
    const viewFullContext = yield* S.ViewObjectFullContext(GenAssets);
    const restoreObject = yield* S.RestoreObject(GenAssets);
    const bulkRestore = yield* S.BulkObjectRestore(GenAssets);
    const restoreBucket = yield* S.RestoreBucket(GenAssets);
    const getManagedFolder = yield* S.GetManagedFolder(ManagedAssets);
    const listManagedFolders = yield* S.ListManagedFolders(ManagedAssets);
    const getFolder = yield* S.GetFolder(FolderAssets);
    const listFolders = yield* S.ListFolders(FolderAssets);
    const renameFolder = yield* S.RenameFolder(FolderAssets);
    const deleteFolderRecursive = yield* S.DeleteFolderRecursive(FolderAssets);
    const moveObject = yield* S.MoveObject(FolderAssets);
    const getHmacKey = yield* S.GetHmacKey(GenHmacKey);
    const listHmacKeys = yield* S.ListHmacKeys();
    const listBuckets = yield* S.ListBuckets();

    const putMarker = yield* GCP.Storage.PutObject(AuditMarkers);
    yield* S.consumeBucketAuditLogs(GenAssets, recordAuditLogs("bucket", putMarker));

    return {
      fetch: serveProbes({
        // One probe per call, so a refusal names the call.
        getBucket: getBucket(),
        getLayout: getLayout(),
        listBucketAcls: listBucketAcls(),
        listDefaultAcls: listDefaultAcls(),
        listObjectAcls: listObjectAcls({ object: GEN_SEED }),
        listNotifications: listNotifications(),
        listCaches: listCaches(),
        // Nothing is granted to allUsers, and no notification or cache
        // exists: each call is authorized and not found.
        missingBucketAcl: outcome(getBucketAcl({ entity: "allUsers" })),
        missingDefaultAcl: outcome(getDefaultAcl({ entity: "allUsers" })),
        missingObjectAcl: outcome(getObjectAcl({ object: GEN_SEED, entity: "allUsers" })),
        missingNotification: outcome(getNotification({ notification: "0" })),
        missingCache: outcome(getCache({ anywhereCacheId: "us-central1-a" })),
        updateMissingCache: outcome(
          updateCache({ anywhereCacheId: "us-central1-a", body: { ttl: "86400s" } }),
        ),
        pauseMissingCache: outcome(pauseCache({ anywhereCacheId: "us-central1-a" })),
        resumeMissingCache: outcome(resumeCache({ anywhereCacheId: "us-central1-a" })),
        disableMissingCache: outcome(disableCache({ anywhereCacheId: "us-central1-a" })),
        // The bucket is live, so there is nothing to restore.
        restoreLiveBucket: outcome(restoreBucket({ generation: "1" })),
        missingContext: outcome(viewFullContext({ object: GEN_SEED, contextKey: "none" })),
        genObjects: Effect.gen(function* () {
          const bucketName = yield* probeParam("bucket");
          const composed = yield* composeObject({
            destinationObject: "gen/composed.txt",
            body: { sourceObjects: [{ name: GEN_SEED }, { name: GEN_PART }] },
          });
          const copied = yield* copyObject({
            sourceObject: GEN_SEED,
            destinationBucket: bucketName,
            destinationObject: "gen/copied.txt",
          });
          const rewritten = yield* rewriteObject({
            sourceObject: GEN_SEED,
            destinationBucket: bucketName,
            destinationObject: "gen/rewritten.txt",
          });
          const patched = yield* patchObject({
            object: GEN_SEED,
            body: { metadata: { patched: "yes" } },
          });
          const updated = yield* updateObject({
            object: GEN_PART,
            body: { contentType: "text/plain", metadata: { updated: "yes" } },
          });
          return {
            composed: composed.name,
            copied: copied.name,
            rewritten: rewritten.done,
            patched: patched.metadata,
            updated: updated.metadata,
          };
        }),
        genRestore: Effect.gen(function* () {
          const generation = yield* probeParam("generation");
          const restored = yield* restoreObject({ object: GEN_RESTORE, generation });
          const bulk = yield* bulkRestore({
            body: { matchGlobs: ["gen/never-*"], allowOverwrite: false },
          });
          return { restored: restored.name, bulk: bulk.name !== undefined };
        }),
        managed: Effect.all({
          folder: getManagedFolder({ managedFolder: "managed/" }),
          list: listManagedFolders(),
        }),
        folders: Effect.gen(function* () {
          const kept = yield* getFolder({ folder: "keep/" });
          const listed = yield* listFolders();
          const renamed = yield* renameFolder({
            sourceFolder: "rename-me/",
            destinationFolder: "renamed/",
          });
          // Recursive delete is a bucket opt-in this bucket doesn't have.
          const dropped = yield* outcome(deleteFolderRecursive({ folder: "drop/" }));
          const moved = yield* moveObject({
            sourceObject: "keep/source.txt",
            destinationObject: "keep/moved.txt",
          });
          return {
            kept: kept.name,
            listed: (listed.items ?? []).map((folder) => folder.name),
            renamed: renamed.name !== undefined,
            dropped,
            moved: moved.name,
          };
        }),
        hmac: Effect.gen(function* () {
          const key = yield* getHmacKey();
          const listed = yield* listHmacKeys({ serviceAccountEmail: key.serviceAccountEmail });
          return {
            accessId: key.accessId,
            listed: (listed.items ?? []).map((item) => item.accessId),
          };
        }),
        buckets: Effect.gen(function* () {
          const page = yield* listBuckets({ prefix: yield* probeParam("prefix") });
          return (page.items ?? []).map((item) => item.name);
        }),
        readBucket: forbiddenAsTag(
          Effect.gen(function* () {
            const head = yield* readBucket.head(SEED_KEY);
            const object = yield* readBucket.get(SEED_KEY);
            const listed = yield* readBucket.list({ prefix: "seed/" });
            const missingHead = yield* readBucket.head("missing.txt");
            const missingGet = yield* readBucket.get("missing.txt");
            return {
              headName: head?.name,
              headSize: head?.size,
              text: object && text(object.body),
              contentType: object?.contentType,
              listed: listed.objects.map((item) => item.name),
              missingHead: missingHead === undefined,
              missingGet: missingGet === undefined,
            };
          }),
        ),
        writeBucketPut: forbiddenAsTag(
          writeBucket
            .put("written.txt", "hello from WriteBucket", {
              contentType: "text/plain",
              metadata: { source: "write-bucket" },
            })
            .pipe(Effect.map((object) => ({ name: object.name }))),
        ),
        writeBucketDelete: Effect.gen(function* () {
          yield* writeBucket.delete("written.txt");
          // Deleting a missing object succeeds.
          yield* writeBucket.delete("missing.txt");
          return { deleted: "written.txt" };
        }),
        readWriteBucket: forbiddenAsTag(
          Effect.gen(function* () {
            const put = yield* readWriteBucket.put("round-trip.txt", "hello from ReadWriteBucket");
            const object = yield* readWriteBucket.get("round-trip.txt");
            const listed = yield* readWriteBucket.list();
            return {
              putName: put.name,
              text: object && text(object.body),
              listed: listed.objects.map((item) => item.name),
            };
          }),
        ),
        readWriteBucketDelete: Effect.gen(function* () {
          yield* readWriteBucket.delete("round-trip.txt");
          const after = yield* readWriteBucket.head("round-trip.txt");
          return { gone: after === undefined };
        }),
        getObject: forbiddenAsTag(
          Effect.gen(function* () {
            const object = yield* getObject({ object: SEED_KEY });
            return { text: text(object.body), contentType: object.contentType };
          }),
        ),
        getObjectMissing: forbiddenAsTag(getObject({ object: "missing.txt" })),
        putObject: forbiddenAsTag(
          putObject({
            name: "put.bin",
            body: new TextEncoder().encode("hello from PutObject"),
            contentType: "application/octet-stream",
            metadata: { source: "put-object" },
          }).pipe(
            Effect.map((object) => ({
              name: object.name,
              metadata: object.metadata,
            })),
          ),
        ),
        deleteObject: deleteObject({ object: SEED_KEY }).pipe(Effect.as({ deleted: SEED_KEY })),
        deleteObjectMissing: deleteObject({ object: "missing.txt" }),
        signGetObjectUrl: signGetObjectUrl({
          object: SEED_KEY,
          expiresIn: 600,
          contentType: "text/plain",
        }).pipe(Effect.map((url) => ({ url }))),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Storage.ReadBucketHttp),
    Effect.provide(GCP.Storage.WriteBucketHttp),
    Effect.provide(GCP.Storage.ReadWriteBucketHttp),
    Effect.provide(GCP.Storage.GetObjectHttp),
    Effect.provide(GCP.Storage.PutObjectHttp),
    Effect.provide(GCP.Storage.DeleteObjectHttp),
    Effect.provide(GCP.Storage.SignGetObjectUrlHttp),
    Effect.provide(
      Layer.mergeAll(
        GCP.Storage.GetBucketHttp,
        GCP.Storage.GetBucketStorageLayoutHttp,
        GCP.Storage.ListBucketAccessControlsHttp,
        GCP.Storage.GetBucketAccessControlHttp,
        GCP.Storage.ListDefaultObjectAccessControlsHttp,
        GCP.Storage.GetDefaultObjectAccessControlHttp,
        GCP.Storage.ListObjectAccessControlsHttp,
        GCP.Storage.GetObjectAccessControlHttp,
        GCP.Storage.ListNotificationsHttp,
        GCP.Storage.GetNotificationHttp,
        GCP.Storage.ListAnywhereCachesHttp,
        GCP.Storage.GetAnywhereCacheHttp,
        GCP.Storage.UpdateAnywhereCacheHttp,
        GCP.Storage.PauseAnywhereCacheHttp,
        GCP.Storage.ResumeAnywhereCacheHttp,
        GCP.Storage.DisableAnywhereCacheHttp,
        GCP.Storage.ComposeObjectHttp,
        GCP.Storage.CopyObjectHttp,
        GCP.Storage.RewriteObjectHttp,
        GCP.Storage.PatchObjectHttp,
        GCP.Storage.UpdateObjectHttp,
        GCP.Storage.ViewObjectFullContextHttp,
        GCP.Storage.RestoreObjectHttp,
        GCP.Storage.BulkObjectRestoreHttp,
        GCP.Storage.RestoreBucketHttp,
      ),
    ),
    Effect.provide(
      Layer.mergeAll(
        GCP.Storage.GetManagedFolderHttp,
        GCP.Storage.ListManagedFoldersHttp,
        GCP.Storage.GetFolderHttp,
        GCP.Storage.ListFoldersHttp,
        GCP.Storage.RenameFolderHttp,
        GCP.Storage.DeleteFolderRecursiveHttp,
        GCP.Storage.MoveObjectHttp,
        GCP.Storage.GetHmacKeyHttp,
        GCP.Storage.ListHmacKeysHttp,
        GCP.Storage.ListBucketsHttp,
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
      ),
    ),
  ),
) {}
