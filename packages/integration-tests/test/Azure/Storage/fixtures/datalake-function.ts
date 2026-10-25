import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
// TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the Data Lake binding fixture consumes. Module-scope so the test
// can yield the same declarations.

/** Hierarchical-namespace account holding one filesystem per binding. */
export const Lake = Azure.Storage.StorageAccount("DataLakeBindingsLake", { isHnsEnabled: true });
/** Second account for the account-scoped bindings, so their grants never cover `Lake`. */
export const LakeAdmin = Azure.Storage.StorageAccount("DataLakeBindingsAdmin", {
  isHnsEnabled: true,
});
/** Blob soft delete, so `UndeletePath` has something to restore. */
export const LakeBlobService = Effect.gen(function* () {
  const account = yield* Lake;
  return yield* Azure.Storage.BlobServiceProperties("DataLakeBindingsBlobService", {
    storageAccount: account.storageAccountName,
    deleteRetentionPolicy: { enabled: true, days: 1 },
  });
});

const fileSystem = (id: string) =>
  Effect.gen(function* () {
    const account = yield* Lake;
    return yield* Azure.Storage.BlobContainer(id, { storageAccount: account.storageAccountName });
  });

/** One filesystem per binding, so each grant is the only one on its scope. */
export const FileSystems = {
  createPath: fileSystem("DlCreatePath"),
  appendPathData: fileSystem("DlAppendPathData"),
  flushPathData: fileSystem("DlFlushPathData"),
  readPath: fileSystem("DlReadPath"),
  getPathProperties: fileSystem("DlGetPathProperties"),
  deletePath: fileSystem("DlDeletePath"),
  listPaths: fileSystem("DlListPaths"),
  listBlobs: fileSystem("DlListBlobs"),
  renamePath: fileSystem("DlRenamePath"),
  setPathAccessControl: fileSystem("DlSetPathAccessControl"),
  setPathAccessControlRecursive: fileSystem("DlSetPathAclRecursive"),
  leasePath: fileSystem("DlLeasePath"),
  setPathExpiry: fileSystem("DlSetPathExpiry"),
  undeletePath: fileSystem("DlUndeletePath"),
  setPathProperties: fileSystem("DlSetPathProperties"),
  getFileSystemProperties: fileSystem("DlGetFileSystemProperties"),
  setFileSystemProperties: fileSystem("DlSetFileSystemProperties"),
  read: fileSystem("DlRead"),
  write: fileSystem("DlWrite"),
  readWrite: fileSystem("DlReadWrite"),
};

export type FileSystemKey = keyof typeof FileSystems;

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

/**
 * Effect-native Azure Function with one route per `storage-datalake`
 * binding. Routes answer `{ ok, result | error }` with a 500 on error, so a
 * caller retries through role propagation and a real failure shows the
 * Azure error.
 */
export default class DataLakeFunction extends Azure.Functions.Function<DataLakeFunction>()(
  "DataLakeBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const fs = {
      createPath: yield* FileSystems.createPath,
      appendPathData: yield* FileSystems.appendPathData,
      flushPathData: yield* FileSystems.flushPathData,
      readPath: yield* FileSystems.readPath,
      getPathProperties: yield* FileSystems.getPathProperties,
      deletePath: yield* FileSystems.deletePath,
      listPaths: yield* FileSystems.listPaths,
      listBlobs: yield* FileSystems.listBlobs,
      renamePath: yield* FileSystems.renamePath,
      setPathAccessControl: yield* FileSystems.setPathAccessControl,
      setPathAccessControlRecursive: yield* FileSystems.setPathAccessControlRecursive,
      leasePath: yield* FileSystems.leasePath,
      setPathExpiry: yield* FileSystems.setPathExpiry,
      undeletePath: yield* FileSystems.undeletePath,
      setPathProperties: yield* FileSystems.setPathProperties,
      getFileSystemProperties: yield* FileSystems.getFileSystemProperties,
      setFileSystemProperties: yield* FileSystems.setFileSystemProperties,
      read: yield* FileSystems.read,
      write: yield* FileSystems.write,
      readWrite: yield* FileSystems.readWrite,
    };
    const admin = yield* LakeAdmin;

    const createPath = yield* Azure.Storage.CreatePath(fs.createPath);
    const appendPathData = yield* Azure.Storage.AppendPathData(fs.appendPathData);
    const flushPathData = yield* Azure.Storage.FlushPathData(fs.flushPathData);
    const readPath = yield* Azure.Storage.ReadPath(fs.readPath);
    const getPathProperties = yield* Azure.Storage.GetPathProperties(fs.getPathProperties);
    const deletePath = yield* Azure.Storage.DeletePath(fs.deletePath);
    const listPaths = yield* Azure.Storage.ListPaths(fs.listPaths);
    const listBlobs = yield* Azure.Storage.ListFileSystemBlobHierarchy(fs.listBlobs);
    const renamePath = yield* Azure.Storage.RenamePath(fs.renamePath);
    const setPathAccessControl = yield* Azure.Storage.SetPathAccessControl(fs.setPathAccessControl);
    const setAclRecursive = yield* Azure.Storage.SetPathAccessControlRecursive(
      fs.setPathAccessControlRecursive,
    );
    const leasePath = yield* Azure.Storage.LeasePath(fs.leasePath);
    const setPathExpiry = yield* Azure.Storage.SetPathExpiry(fs.setPathExpiry);
    const undeletePath = yield* Azure.Storage.UndeletePath(fs.undeletePath);
    const setPathProperties = yield* Azure.Storage.SetPathProperties(fs.setPathProperties);
    const getFileSystemProperties = yield* Azure.Storage.GetFileSystemProperties(
      fs.getFileSystemProperties,
    );
    const setFileSystemProperties = yield* Azure.Storage.SetFileSystemProperties(
      fs.setFileSystemProperties,
    );
    const createFileSystem = yield* Azure.Storage.CreateFileSystem(admin);
    const deleteFileSystem = yield* Azure.Storage.DeleteFileSystem(admin);
    const listFileSystems = yield* Azure.Storage.ListFileSystems(admin);
    const reader = yield* Azure.Storage.DataLakeFileSystemRead(fs.read);
    const writer = yield* Azure.Storage.DataLakeFileSystemWrite(fs.write);
    const readWriter = yield* Azure.Storage.DataLakeFileSystemReadWrite(fs.readWrite);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const q = (name: string) => url.searchParams.get(name) ?? undefined;
        const path = q("path") ?? "";
        switch (url.pathname) {
          case "/create-path":
            return yield* respond(
              createPath({ path, resource: q("resource") === "directory" ? "directory" : "file" }),
            );
          case "/append":
            return yield* respond(
              appendPathData({
                path,
                position: Number(q("position") ?? 0),
                body: encode(q("text") ?? ""),
              }),
            );
          case "/flush":
            return yield* respond(flushPathData({ path, position: Number(q("position") ?? 0) }));
          case "/read-path":
            return yield* respond(
              Effect.map(readPath({ path }), (file) => ({
                text: decode(file.body),
                contentLength: file.contentLength,
              })),
            );
          case "/get-path-properties":
            return yield* respond(
              Effect.gen(function* () {
                const props = yield* getPathProperties({ path });
                const acl = yield* getPathProperties({ path, action: "getAccessControl" });
                return {
                  resourceType: props.xMsResourceType,
                  contentLength: props.contentLength,
                  acl: acl.xMsAcl,
                };
              }),
            );
          case "/delete-path":
            return yield* respond(
              deletePath({ path, recursive: q("recursive") === "true" ? true : undefined }),
            );
          case "/list-paths":
            return yield* respond(
              Effect.map(listPaths({ directory: q("directory"), recursive: true }), (page) =>
                page.paths.map((p) => `${p.name}${p.isDirectory === "true" ? "/" : ""}`).sort(),
              ),
            );
          case "/list-blobs":
            return yield* respond(
              Effect.map(listBlobs({ prefix: q("prefix"), delimiter: "/" }), (page) => ({
                blobs: page.Segment.BlobItems.map((item) => item.Name).sort(),
                prefixes: (page.Segment.BlobPrefixes ?? []).map((prefix) => prefix.Name).sort(),
              })),
            );
          case "/rename-path":
            return yield* respond(renamePath({ source: q("source") ?? "", path }));
          case "/set-acl":
            return yield* respond(setPathAccessControl({ path, xMsAcl: q("acl") }));
          case "/set-acl-recursive":
            return yield* respond(
              Effect.map(setAclRecursive({ path, mode: "modify", xMsAcl: q("acl") }), (result) => ({
                directoriesSuccessful: result.directoriesSuccessful,
                filesSuccessful: result.filesSuccessful,
                failureCount: result.failureCount,
              })),
            );
          case "/lease": {
            const action = q("action") ?? "acquire";
            const leaseId = q("leaseId");
            return yield* respond(
              leasePath(
                action === "acquire"
                  ? {
                      path,
                      xMsLeaseAction: "acquire",
                      xMsLeaseDuration: 60,
                      xMsProposedLeaseId: leaseId,
                    }
                  : { path, xMsLeaseAction: action, xMsLeaseId: leaseId },
              ),
            );
          }
          case "/expiry":
            return yield* respond(
              setPathExpiry({
                path,
                xMsExpiryOption: "RelativeToNow",
                xMsExpiryTime: q("ms") ?? "3600000",
              }),
            );
          case "/undelete":
            return yield* respond(
              undeletePath({ path, xMsUndeleteSource: `${path}?deletionid=${q("deletionId")}` }),
            );
          case "/set-path-properties":
            return yield* respond(setPathProperties({ path, xMsContentType: q("contentType") }));
          case "/get-fs-properties":
            return yield* respond(
              Effect.map(getFileSystemProperties(), (props) => ({
                namespaceEnabled: props.xMsNamespaceEnabled,
                properties: props.xMsProperties,
              })),
            );
          case "/set-fs-properties":
            return yield* respond(
              setFileSystemProperties({
                xMsProperties: `${q("name")}=${btoa(q("value") ?? "")}`,
              }),
            );
          case "/create-fs":
            return yield* respond(createFileSystem({ filesystem: q("name") ?? "" }));
          case "/delete-fs":
            return yield* respond(deleteFileSystem({ filesystem: q("name") ?? "" }));
          case "/list-fs":
            return yield* respond(
              Effect.map(listFileSystems({ prefix: q("prefix") }), (page) =>
                page.filesystems.map((f) => f.name).sort(),
              ),
            );
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const file = yield* reader.read(path);
                const missing = yield* reader.read(`${path}-missing`);
                const props = yield* reader.getProperties(path);
                const missingProps = yield* reader.getProperties(`${path}-missing`);
                const listed = yield* reader.list({ directory: q("directory"), recursive: true });
                return {
                  text: file?.text(),
                  missing: missing === undefined,
                  size: props?.size,
                  isDirectory: props?.isDirectory,
                  missingProps: missingProps === undefined,
                  paths: listed.paths.map((p) => `${p.path}${p.isDirectory ? "/" : ""}`).sort(),
                };
              }),
            );
          case "/write": {
            const dir = q("dir") ?? "";
            return yield* respond(
              Effect.gen(function* () {
                yield* writer.createDirectory(dir);
                const { etag } = yield* writer.write(`${dir}/a.txt`, q("text") ?? "", {
                  contentType: "text/plain",
                });
                yield* writer.rename(`${dir}/a.txt`, `${dir}/b.txt`);
                return { etag };
              }),
            );
          }
          case "/write-delete":
            return yield* respond(
              Effect.gen(function* () {
                yield* writer.delete(q("dir") ?? "", { recursive: true });
                // Deleting a missing path succeeds.
                yield* writer.delete(q("dir") ?? "", { recursive: true });
              }),
            );
          case "/read-write": {
            const dir = q("dir") ?? "";
            return yield* respond(
              Effect.gen(function* () {
                yield* readWriter.createDirectory(dir);
                yield* readWriter.write(`${dir}/a.txt`, q("text") ?? "");
                const file = yield* readWriter.read(`${dir}/a.txt`);
                const props = yield* readWriter.getProperties(`${dir}/a.txt`);
                yield* readWriter.rename(`${dir}/a.txt`, `${dir}/b.txt`);
                const listed = yield* readWriter.list({ directory: dir });
                return {
                  text: file?.text(),
                  contentType: props?.contentType,
                  size: props?.size,
                  paths: listed.paths.map((p) => p.path).sort(),
                };
              }),
            );
          }
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Storage.CreatePathHttp,
        Azure.Storage.AppendPathDataHttp,
        Azure.Storage.FlushPathDataHttp,
        Azure.Storage.ReadPathHttp,
        Azure.Storage.GetPathPropertiesHttp,
        Azure.Storage.DeletePathHttp,
        Azure.Storage.ListPathsHttp,
        Azure.Storage.ListFileSystemBlobHierarchyHttp,
        Azure.Storage.RenamePathHttp,
        Azure.Storage.SetPathAccessControlHttp,
        Azure.Storage.SetPathAccessControlRecursiveHttp,
        Azure.Storage.LeasePathHttp,
        Azure.Storage.SetPathExpiryHttp,
        Azure.Storage.UndeletePathHttp,
        Azure.Storage.SetPathPropertiesHttp,
        Azure.Storage.GetFileSystemPropertiesHttp,
        Azure.Storage.SetFileSystemPropertiesHttp,
        Azure.Storage.CreateFileSystemHttp,
        Azure.Storage.DeleteFileSystemHttp,
        Azure.Storage.ListFileSystemsHttp,
        Azure.Storage.DataLakeFileSystemReadHttp,
        Azure.Storage.DataLakeFileSystemWriteHttp,
        Azure.Storage.DataLakeFileSystemReadWriteHttp,
      ),
    ),
  ),
) {}
