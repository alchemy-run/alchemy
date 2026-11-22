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

/** Holds every bound SMB share. */
export const FileAccount = Azure.Storage.StorageAccount("FileBindingsData");

/**
 * Premium `FileStorage` account for the NFS share: hard and symbolic links
 * exist only on NFS shares.
 */
export const NfsAccount = Azure.Storage.StorageAccount("FileBindingsNfs", {
  kind: "FileStorage",
  sku: "Premium_LRS",
});

const share = (id: string, props?: { accessPolicies?: Azure.Storage.StorageAccessPolicy[] }) =>
  Effect.gen(function* () {
    const account = yield* FileAccount;
    return yield* Azure.Storage.FileShare(id, {
      storageAccount: account.storageAccountName,
      shareQuota: 1,
      ...props,
    });
  });

/**
 * One share per role kind, so each binding's role is the only grant on the
 * share its operations run against.
 */
export const Shares = {
  /** Storage File Data Privileged Reader: the read bindings and FileShareRead. */
  reads: share("FileReads"),
  /** Custom `files/write`: create, upload, metadata, headers, directories. */
  writes: share("FileWrites"),
  /** Custom `files/delete`. */
  deletes: share("FileDeletes"),
  /** Custom `files/write` + `files/delete`: FileShareWrite. */
  writeClient: share("FileWriteClient"),
  /** All three: FileShareReadWrite. */
  clients: share("FileClients"),
  /** Privileged Reader + custom `files/write`: StartCopyFile (it reads the source with the same token). */
  copies: share("FileCopies"),
  /** Custom `files/modifypermissions/action`: CreateSharePermission. */
  permissions: share("FilePermissions"),
  /** Custom `shares/read`: share properties, access policy, statistics. */
  shareReads: share("FileShareReads", {
    accessPolicies: [{ id: "readers", permission: "rl", expiryTime: "2030-01-01T00:00:00Z" }],
  }),
  /** Custom `shares/write`: share properties, metadata, access policy, snapshots. */
  shareWrites: share("FileShareWrites"),
  /** Custom `shares/lease/action`: share leases. */
  leases: share("FileShareLeases"),
  /** NFS share (100 GiB, the premium minimum): custom `files/write` + Privileged Reader for links. */
  links: Effect.gen(function* () {
    const account = yield* NfsAccount;
    return yield* Azure.Storage.FileShare("FileLinks", {
      storageAccount: account.storageAccountName,
      shareQuota: 100,
      enabledProtocols: "NFS",
    });
  }),
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
 * Effect-native Azure Function exercising every `storage-file` binding on a
 * managed-identity host:
 *
 * - `GET /op/<Binding>?req=<json>` calls the per-operation binding with the
 *   request (`{ $text }` becomes bytes);
 * - `GET /client/<read|write|readWrite>/<method>?args=<json>` calls a
 *   FileShareRead / Write / ReadWrite client method (a `text()` result is
 *   returned as `text`).
 */
export default class FileShareBindingsFunction extends Azure.Functions.Function<FileShareBindingsFunction>()(
  "FileShareBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const reads = yield* Shares.reads;
    const writes = yield* Shares.writes;
    const deletes = yield* Shares.deletes;
    const writeClient = yield* Shares.writeClient;
    const clients = yield* Shares.clients;
    const copies = yield* Shares.copies;
    const permissions = yield* Shares.permissions;
    const shareReads = yield* Shares.shareReads;
    const shareWrites = yield* Shares.shareWrites;
    const leases = yield* Shares.leases;
    const links = yield* Shares.links;
    const S = Azure.Storage;

    const ops: Record<string, Callable> = {
      DownloadFile: yield* S.DownloadFile(reads),
      GetFileProperties: yield* S.GetFileProperties(reads),
      ListFilesAndDirectories: yield* S.ListFilesAndDirectories(reads),
      GetDirectoryProperties: yield* S.GetDirectoryProperties(reads),
      GetFileRangeList: yield* S.GetFileRangeList(reads),
      ListFileHandles: yield* S.ListFileHandles(reads),
      ListDirectoryHandles: yield* S.ListDirectoryHandles(reads),
      GetSharePermission: yield* S.GetSharePermission(reads),

      CreateFile: yield* S.CreateFile(writes),
      UploadFileRange: yield* S.UploadFileRange(writes),
      CreateDirectory: yield* S.CreateDirectory(writes),
      SetFileMetadata: yield* S.SetFileMetadata(writes),
      SetFileHTTPHeaders: yield* S.SetFileHTTPHeaders(writes),
      SetDirectoryMetadata: yield* S.SetDirectoryMetadata(writes),
      StartCopyFile: yield* S.StartCopyFile(copies),
      AbortCopyFile: yield* S.AbortCopyFile(writes),
      UploadFileRangeFromUrl: yield* S.UploadFileRangeFromUrl(writes),
      AcquireFileLease: yield* S.AcquireFileLease(writes),
      ReleaseFileLease: yield* S.ReleaseFileLease(writes),
      ChangeFileLease: yield* S.ChangeFileLease(writes),
      BreakFileLease: yield* S.BreakFileLease(writes),
      ForceCloseFileHandles: yield* S.ForceCloseFileHandles(writes),
      ForceCloseDirectoryHandles: yield* S.ForceCloseDirectoryHandles(writes),
      RenameFile: yield* S.RenameFile(writes),
      RenameDirectory: yield* S.RenameDirectory(writes),
      SetDirectoryProperties: yield* S.SetDirectoryProperties(writes),

      DeleteFile: yield* S.DeleteFile(deletes),
      DeleteDirectory: yield* S.DeleteDirectory(deletes),

      CreateSharePermission: yield* S.CreateSharePermission(permissions),

      GetShareProperties: yield* S.GetShareProperties(shareReads),
      GetShareAccessPolicy: yield* S.GetShareAccessPolicy(shareReads),
      GetShareStatistics: yield* S.GetShareStatistics(shareReads),

      SetShareProperties: yield* S.SetShareProperties(shareWrites),
      SetShareMetadata: yield* S.SetShareMetadata(shareWrites),
      SetShareAccessPolicy: yield* S.SetShareAccessPolicy(shareWrites),
      CreateShareSnapshot: yield* S.CreateShareSnapshot(shareWrites),

      AcquireShareLease: yield* S.AcquireShareLease(leases),
      ReleaseShareLease: yield* S.ReleaseShareLease(leases),
      ChangeShareLease: yield* S.ChangeShareLease(leases),
      BreakShareLease: yield* S.BreakShareLease(leases),
      RenewShareLease: yield* S.RenewShareLease(leases),

      CreateFileHardLink: yield* S.CreateFileHardLink(links),
      CreateFileSymbolicLink: yield* S.CreateFileSymbolicLink(links),
      GetFileSymbolicLink: yield* S.GetFileSymbolicLink(links),
    };

    const read = yield* S.FileShareRead(reads);
    const write = yield* S.FileShareWrite(writeClient);
    const readWrite = yield* S.FileShareReadWrite(clients);
    const clientsByName: Record<string, object> = { read, write, readWrite };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const [, route, first, second] = url.pathname.split("/");
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
            return yield* respond(
              Effect.map(method(...args), (result) => {
                const file = result as { text?: () => string } | undefined;
                return typeof file?.text === "function" ? { ...file, text: file.text() } : result;
              }),
            );
          }
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Storage.DownloadFileHttp,
        Azure.Storage.GetFilePropertiesHttp,
        Azure.Storage.ListFilesAndDirectoriesHttp,
        Azure.Storage.GetDirectoryPropertiesHttp,
        Azure.Storage.GetFileRangeListHttp,
        Azure.Storage.CreateFileHttp,
        Azure.Storage.UploadFileRangeHttp,
        Azure.Storage.CreateDirectoryHttp,
        Azure.Storage.SetFileMetadataHttp,
        Azure.Storage.SetFileHTTPHeadersHttp,
        Azure.Storage.SetDirectoryMetadataHttp,
        Azure.Storage.DeleteFileHttp,
        Azure.Storage.DeleteDirectoryHttp,
        Azure.Storage.ListFileHandlesHttp,
        Azure.Storage.ListDirectoryHandlesHttp,
        Azure.Storage.GetSharePermissionHttp,
        Azure.Storage.StartCopyFileHttp,
        Azure.Storage.AbortCopyFileHttp,
        Azure.Storage.UploadFileRangeFromUrlHttp,
        Azure.Storage.AcquireFileLeaseHttp,
        Azure.Storage.ReleaseFileLeaseHttp,
        Azure.Storage.ChangeFileLeaseHttp,
        Azure.Storage.BreakFileLeaseHttp,
        Azure.Storage.ForceCloseFileHandlesHttp,
        Azure.Storage.ForceCloseDirectoryHandlesHttp,
        Azure.Storage.RenameFileHttp,
        Azure.Storage.RenameDirectoryHttp,
        Azure.Storage.SetDirectoryPropertiesHttp,
        Azure.Storage.CreateSharePermissionHttp,
        Azure.Storage.GetSharePropertiesHttp,
        Azure.Storage.GetShareAccessPolicyHttp,
        Azure.Storage.GetShareStatisticsHttp,
        Azure.Storage.SetSharePropertiesHttp,
        Azure.Storage.SetShareMetadataHttp,
        Azure.Storage.SetShareAccessPolicyHttp,
        Azure.Storage.CreateShareSnapshotHttp,
        Azure.Storage.AcquireShareLeaseHttp,
        Azure.Storage.ReleaseShareLeaseHttp,
        Azure.Storage.ChangeShareLeaseHttp,
        Azure.Storage.BreakShareLeaseHttp,
        Azure.Storage.RenewShareLeaseHttp,
        Azure.Storage.CreateFileHardLinkHttp,
        Azure.Storage.CreateFileSymbolicLinkHttp,
        Azure.Storage.GetFileSymbolicLinkHttp,
        Azure.Storage.FileShareReadHttp,
        Azure.Storage.FileShareWriteHttp,
        Azure.Storage.FileShareReadWriteHttp,
      ),
    ),
  ),
) {}
