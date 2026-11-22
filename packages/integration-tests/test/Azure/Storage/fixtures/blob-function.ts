import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
// TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/**
 * Holds every bound container. Blob soft delete (for `UndeleteBlob`) and
 * public blob access (the `…FromUrl` sources) are on.
 */
export const BlobAccount = Azure.Storage.StorageAccount("BlobBindingsData", {
  allowBlobPublicAccess: true,
});

export const BlobService = Effect.gen(function* () {
  const account = yield* BlobAccount;
  return yield* Azure.Storage.BlobServiceProperties("BlobBindingsService", {
    storageAccount: account.storageAccountName,
    deleteRetentionPolicy: { enabled: true, days: 1 },
  });
});

/**
 * Bound by the account-level bindings (container list/create/delete/restore,
 * service properties, replication stats, account-wide tag search). Read-access
 * geo-redundant for `GetBlobServiceStatistics`; container soft delete for
 * `RestoreBlobContainer`.
 */
export const ServiceAccount = Azure.Storage.StorageAccount("BlobBindingsSvc", {
  sku: "Standard_RAGRS",
});

export const ServiceAccountSettings = Effect.gen(function* () {
  const account = yield* ServiceAccount;
  return yield* Azure.Storage.BlobServiceProperties("BlobBindingsSvcService", {
    storageAccount: account.storageAccountName,
    deleteRetentionPolicy: { enabled: true, days: 2 },
    containerDeleteRetentionPolicy: { enabled: true, days: 1 },
  });
});

const container = (
  id: string,
  publicAccess?: "Blob",
  inAccount: typeof BlobAccount = BlobAccount,
) =>
  Effect.gen(function* () {
    const account = yield* inAccount;
    return yield* Azure.Storage.BlobContainer(id, {
      storageAccount: account.storageAccountName,
      publicAccess,
    });
  });

/**
 * One container per role kind, so each binding's role is the only grant on
 * the container its operations run against.
 */
export const Containers = {
  /** Storage Blob Data Reader: the read bindings. */
  reads: container("BlobReads"),
  /** Custom `blobs/write`: block, append, page, metadata, lease, undelete, `…FromUrl`. */
  writes: container("BlobWrites"),
  /** Custom `blobs/read` + `blobs/write`: same-container copies. */
  copies: container("BlobCopies"),
  /** Custom `blobs/delete`. */
  deletes: container("BlobDeletes"),
  /** Custom `blobs/tags/read`, `blobs/tags/write`, `blobs/filter/action`. */
  tags: container("BlobTags"),
  /** Custom `containers/read`, `containers/write`, ACL, and immutability roles. */
  meta: container("BlobMeta"),
  /** Container leases (Custom `containers/write`); serialized in the test. */
  leases: container("BlobLeases"),
  /** BlobContainerRead / Write / ReadWrite clients. */
  clients: container("BlobClients"),
  /** Public-read sources for the `…FromUrl` operations (no binding). */
  sources: container("BlobSources", "Blob"),
  /** Tagged blobs `FindBlobsByTagsInAccount` finds (no container-level binding). */
  svcTags: container("BlobSvcTags", undefined, ServiceAccount),
};

/** Turn `{ $text }` markers into bytes (a JSON request cannot carry a `Uint8Array`). */
const decodeBytes = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$text === "string") return new TextEncoder().encode(record.$text);
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decodeBytes(v)]));
  }
  return value;
};

/** Turn bytes into `{ $text }` so a response survives JSON. */
const encodeBytes = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return { $text: new TextDecoder().decode(value) };
  if (Array.isArray(value)) return value.map(encodeBytes);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => typeof v !== "function")
        .map(([k, v]) => [k, encodeBytes(v)]),
    );
  }
  return value;
};

/**
 * Answer `{ ok: true, result }`, or `{ ok: false, tag, error }` for a typed
 * failure (status 200, so the caller can assert the tag), or a 500 for a
 * defect so the caller retries.
 */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: encodeBytes(result) })),
    Effect.catch((error) =>
      HttpServerResponse.json({
        ok: false,
        tag: (error as { _tag?: unknown } | undefined)?._tag,
        error: String((error as { message?: unknown } | undefined)?.message ?? error),
      }),
    ),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** A bound operation or client method, called with the test's JSON arguments. */
type Callable = (...args: never[]) => Effect.Effect<unknown, unknown, RuntimeContext>;

/**
 * Effect-native Azure Function exercising every `storage-blob` binding on a
 * managed-identity host:
 *
 * - `GET /op/<Binding>?req=<json>` calls the per-operation binding with the
 *   request (`{ $text }` becomes bytes);
 * - `GET /client/<read|write|readWrite>/<method>?args=<json>` calls a
 *   BlobContainerRead / Write / ReadWrite client method;
 * - `GET /source?text=…` serves bytes for the `…FromUrl` operations.
 */
export default class BlobBindingsFunction extends Azure.Functions.Function<BlobBindingsFunction>()(
  "BlobBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const reads = yield* Containers.reads;
    const writes = yield* Containers.writes;
    const copies = yield* Containers.copies;
    const deletes = yield* Containers.deletes;
    const tags = yield* Containers.tags;
    const meta = yield* Containers.meta;
    const leases = yield* Containers.leases;
    const clients = yield* Containers.clients;
    const serviceAccount = yield* ServiceAccount;
    const S = Azure.Storage;

    const ops: Record<string, Callable> = {
      DownloadBlob: yield* S.DownloadBlob(reads),
      GetBlobProperties: yield* S.GetBlobProperties(reads),
      ListBlobs: yield* S.ListBlobs(reads),
      ListBlobsByHierarchy: yield* S.ListBlobsByHierarchy(reads),
      GetBlockList: yield* S.GetBlockList(reads),
      GetPageRanges: yield* S.GetPageRanges(reads),
      GetPageRangesDiff: yield* S.GetPageRangesDiff(reads),
      QueryBlob: yield* S.QueryBlob(reads),

      UploadBlockBlob: yield* S.UploadBlockBlob(writes),
      StageBlock: yield* S.StageBlock(writes),
      CommitBlockList: yield* S.CommitBlockList(writes),
      CreateAppendBlob: yield* S.CreateAppendBlob(writes),
      AppendBlock: yield* S.AppendBlock(writes),
      SealAppendBlob: yield* S.SealAppendBlob(writes),
      CreatePageBlob: yield* S.CreatePageBlob(writes),
      UploadPages: yield* S.UploadPages(writes),
      ClearPages: yield* S.ClearPages(writes),
      ResizePageBlob: yield* S.ResizePageBlob(writes),
      UpdatePageBlobSequenceNumber: yield* S.UpdatePageBlobSequenceNumber(writes),
      SetBlobHTTPHeaders: yield* S.SetBlobHTTPHeaders(writes),
      SetBlobMetadata: yield* S.SetBlobMetadata(writes),
      SetBlobTier: yield* S.SetBlobTier(writes),
      SetBlobExpiry: yield* S.SetBlobExpiry(writes),
      CreateBlobSnapshot: yield* S.CreateBlobSnapshot(writes),
      AcquireBlobLease: yield* S.AcquireBlobLease(writes),
      ReleaseBlobLease: yield* S.ReleaseBlobLease(writes),
      RenewBlobLease: yield* S.RenewBlobLease(writes),
      ChangeBlobLease: yield* S.ChangeBlobLease(writes),
      BreakBlobLease: yield* S.BreakBlobLease(writes),
      AbortCopyBlob: yield* S.AbortCopyBlob(writes),
      UndeleteBlob: yield* S.UndeleteBlob(writes),
      CopyPageBlobIncremental: yield* S.CopyPageBlobIncremental(writes),
      CopyBlobFromUrl: yield* S.CopyBlobFromUrl(writes),
      PutBlobFromUrl: yield* S.PutBlobFromUrl(writes),
      StageBlockFromUrl: yield* S.StageBlockFromUrl(writes),
      AppendBlockFromUrl: yield* S.AppendBlockFromUrl(writes),
      UploadPagesFromUrl: yield* S.UploadPagesFromUrl(writes),

      StartCopyBlob: yield* S.StartCopyBlob(copies),

      DeleteBlob: yield* S.DeleteBlob(deletes),

      GetBlobTags: yield* S.GetBlobTags(tags),
      SetBlobTags: yield* S.SetBlobTags(tags),
      FindBlobsByTags: yield* S.FindBlobsByTags(tags),

      GetContainerProperties: yield* S.GetContainerProperties(meta),
      SetContainerMetadata: yield* S.SetContainerMetadata(meta),
      GetContainerAccessPolicy: yield* S.GetContainerAccessPolicy(meta),
      SetContainerAccessPolicy: yield* S.SetContainerAccessPolicy(meta),
      SetBlobLegalHold: yield* S.SetBlobLegalHold(meta),
      SetBlobImmutabilityPolicy: yield* S.SetBlobImmutabilityPolicy(meta),
      DeleteBlobImmutabilityPolicy: yield* S.DeleteBlobImmutabilityPolicy(meta),

      AcquireContainerLease: yield* S.AcquireContainerLease(leases),
      ReleaseContainerLease: yield* S.ReleaseContainerLease(leases),
      RenewContainerLease: yield* S.RenewContainerLease(leases),
      ChangeContainerLease: yield* S.ChangeContainerLease(leases),
      BreakContainerLease: yield* S.BreakContainerLease(leases),

      ListBlobContainers: yield* S.ListBlobContainers(serviceAccount),
      CreateBlobContainer: yield* S.CreateBlobContainer(serviceAccount),
      DeleteBlobContainer: yield* S.DeleteBlobContainer(serviceAccount),
      RestoreBlobContainer: yield* S.RestoreBlobContainer(serviceAccount),
      GetBlobServiceProperties: yield* S.GetBlobServiceProperties(serviceAccount),
      SetBlobServiceProperties: yield* S.SetBlobServiceProperties(serviceAccount),
      GetBlobServiceStatistics: yield* S.GetBlobServiceStatistics(serviceAccount),
      FindBlobsByTagsInAccount: yield* S.FindBlobsByTagsInAccount(serviceAccount),
    };

    const read = yield* S.BlobContainerRead(clients);
    const write = yield* S.BlobContainerWrite(clients);
    const readWrite = yield* S.BlobContainerReadWrite(clients);
    const clientsByName: Record<string, object> = { read, write, readWrite };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const [, route, first, second] = url.pathname.split("/");
        if (route === "source") {
          return HttpServerResponse.text(url.searchParams.get("text") ?? "");
        }
        if (route === "op" && first !== undefined && ops[first] !== undefined) {
          const body = decodeBytes(JSON.parse(url.searchParams.get("req") ?? "{}"));
          // The route forwards the test's JSON request unchanged; the binding's
          // request type is not knowable at the route.
          return yield* respond(ops[first](body as never));
        }
        if (route === "client" && first !== undefined && second !== undefined) {
          const client = clientsByName[first] as Record<string, Callable> | undefined;
          const method = client?.[second];
          if (method !== undefined) {
            const args = decodeBytes(JSON.parse(url.searchParams.get("args") ?? "[]")) as never[];
            return yield* respond(method(...args));
          }
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Storage.DownloadBlobHttp,
        Azure.Storage.GetBlobPropertiesHttp,
        Azure.Storage.ListBlobsHttp,
        Azure.Storage.ListBlobsByHierarchyHttp,
        Azure.Storage.GetBlockListHttp,
        Azure.Storage.GetPageRangesHttp,
        Azure.Storage.GetPageRangesDiffHttp,
        Azure.Storage.QueryBlobHttp,
        Azure.Storage.UploadBlockBlobHttp,
        Azure.Storage.StageBlockHttp,
        Azure.Storage.CommitBlockListHttp,
        Azure.Storage.CreateAppendBlobHttp,
        Azure.Storage.AppendBlockHttp,
        Azure.Storage.SealAppendBlobHttp,
        Azure.Storage.CreatePageBlobHttp,
        Azure.Storage.UploadPagesHttp,
        Azure.Storage.ClearPagesHttp,
        Azure.Storage.ResizePageBlobHttp,
        Azure.Storage.UpdatePageBlobSequenceNumberHttp,
        Azure.Storage.SetBlobHTTPHeadersHttp,
        Azure.Storage.SetBlobMetadataHttp,
        Azure.Storage.SetBlobTierHttp,
        Azure.Storage.SetBlobExpiryHttp,
        Azure.Storage.CreateBlobSnapshotHttp,
        Azure.Storage.AcquireBlobLeaseHttp,
        Azure.Storage.ReleaseBlobLeaseHttp,
        Azure.Storage.RenewBlobLeaseHttp,
        Azure.Storage.ChangeBlobLeaseHttp,
        Azure.Storage.BreakBlobLeaseHttp,
        Azure.Storage.AbortCopyBlobHttp,
        Azure.Storage.CopyBlobFromUrlHttp,
        Azure.Storage.PutBlobFromUrlHttp,
        Azure.Storage.StageBlockFromUrlHttp,
        Azure.Storage.AppendBlockFromUrlHttp,
        Azure.Storage.UploadPagesFromUrlHttp,
        Azure.Storage.StartCopyBlobHttp,
        Azure.Storage.CopyPageBlobIncrementalHttp,
        Azure.Storage.DeleteBlobHttp,
        Azure.Storage.GetBlobTagsHttp,
        Azure.Storage.SetBlobTagsHttp,
        Azure.Storage.FindBlobsByTagsHttp,
        Azure.Storage.GetContainerPropertiesHttp,
        Azure.Storage.SetContainerMetadataHttp,
        Azure.Storage.GetContainerAccessPolicyHttp,
        Azure.Storage.SetContainerAccessPolicyHttp,
        Azure.Storage.UndeleteBlobHttp,
        Azure.Storage.SetBlobLegalHoldHttp,
        Azure.Storage.SetBlobImmutabilityPolicyHttp,
        Azure.Storage.DeleteBlobImmutabilityPolicyHttp,
        Azure.Storage.AcquireContainerLeaseHttp,
        Azure.Storage.ReleaseContainerLeaseHttp,
        Azure.Storage.RenewContainerLeaseHttp,
        Azure.Storage.ChangeContainerLeaseHttp,
        Azure.Storage.BreakContainerLeaseHttp,
        Azure.Storage.ListBlobContainersHttp,
        Azure.Storage.CreateBlobContainerHttp,
        Azure.Storage.DeleteBlobContainerHttp,
        Azure.Storage.RestoreBlobContainerHttp,
        Azure.Storage.GetBlobServicePropertiesHttp,
        Azure.Storage.SetBlobServicePropertiesHttp,
        Azure.Storage.GetBlobServiceStatisticsHttp,
        Azure.Storage.FindBlobsByTagsInAccountHttp,
        Azure.Storage.BlobContainerReadHttp,
        Azure.Storage.BlobContainerWriteHttp,
        Azure.Storage.BlobContainerReadWriteHttp,
      ),
    ),
  ),
) {}
