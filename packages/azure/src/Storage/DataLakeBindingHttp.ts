import * as datalake from "@distilled.cloud/azure/storage-datalake";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { BlobContainer } from "./BlobContainer.ts";
import type { ReadDataLakeFileSystemClient } from "./DataLakeFileSystemRead.ts";
import type {
  DataLakePathInfo,
  DeleteDataLakePathOptions,
  ListDataLakePathsOptions,
  WriteDataLakeFileOptions,
} from "./DataLakeFileSystemTypes.ts";
import type { WriteDataLakeFileSystemClient } from "./DataLakeFileSystemWrite.ts";
import type { RenamePathRequest } from "./RenamePath.ts";
import type { SetFileSystemPropertiesRequest } from "./SetFileSystemProperties.ts";
import type { SetPathPropertiesRequest } from "./SetPathProperties.ts";
import type { StorageAccount } from "./StorageAccount.ts";

/**
 * Shared scaffolding for the Azure Data Lake Storage Gen2 bindings
 * (`@distilled.cloud/azure/storage-datalake`): the access each binding
 * needs, the deploy-time grant on the bound filesystem or account, and the
 * builders every `<Op>Http.ts` is a one-line `Layer.effect` over.
 *
 * NOT exported from `index.ts`.
 */

const BLOBS = "Microsoft.Storage/storageAccounts/blobServices/containers/blobs";
const CONTAINERS = "Microsoft.Storage/storageAccounts/blobServices/containers";

/**
 * The access a Data Lake binding needs on the bound resource: a built-in
 * role whose permissions match the operation, or a custom role
 * (`Azure.Authorization.RoleDefinition`) with exactly `actions` /
 * `dataActions`, created once per stack under `customRole` and shared by
 * every host that binds it.
 */
export type DataLakeAccess =
  | { readonly builtInRole: string }
  | {
      readonly customRole: string;
      readonly description: string;
      readonly actions?: readonly string[];
      readonly dataActions?: readonly string[];
    };

export const DataLakeAccess = {
  /** Storage Blob Data Reader: data action `blobs/read` only. */
  read: { builtInRole: BuiltInRole.StorageBlobDataReader },
  /** Storage Blob Data Contributor: read, write, delete, move, add. */
  readWrite: { builtInRole: BuiltInRole.StorageBlobDataContributor },
  /** Create, append to, flush, lease, expire, undelete, or set properties of a path. */
  write: {
    customRole: "DataLakePathWriteRole",
    description: "Alchemy Data Lake binding: write paths",
    dataActions: [`${BLOBS}/write`],
  },
  /** Every write-level data action of Storage Blob Data Contributor, without `read`. */
  writeOnly: {
    customRole: "DataLakePathWriteOnlyRole",
    description: "Alchemy Data Lake binding: write, rename, and delete paths",
    dataActions: [
      `${BLOBS}/write`,
      `${BLOBS}/delete`,
      `${BLOBS}/move/action`,
      `${BLOBS}/add/action`,
    ],
  },
  delete: {
    customRole: "DataLakePathDeleteRole",
    description: "Alchemy Data Lake binding: delete paths",
    dataActions: [`${BLOBS}/delete`],
  },
  /** Rename writes the destination and moves the source. */
  move: {
    customRole: "DataLakePathMoveRole",
    description: "Alchemy Data Lake binding: rename paths",
    dataActions: [`${BLOBS}/write`, `${BLOBS}/move/action`],
  },
  /** Set Access Control can change permissions, ACLs, owner, and group. */
  accessControl: {
    customRole: "DataLakePathAccessControlRole",
    description: "Alchemy Data Lake binding: set path permissions, ACLs, owner, and group",
    dataActions: [`${BLOBS}/modifyPermissions/action`, `${BLOBS}/manageOwnership/action`],
  },
  /** Set Access Control Recursive changes ACLs only. */
  accessControlRecursive: {
    customRole: "DataLakePathAclRole",
    description: "Alchemy Data Lake binding: set path ACLs recursively",
    dataActions: [`${BLOBS}/modifyPermissions/action`],
  },
  /** Read filesystem properties, or list the account's filesystems. */
  fileSystemRead: {
    customRole: "DataLakeFileSystemReadRole",
    description: "Alchemy Data Lake binding: read filesystems",
    actions: [`${CONTAINERS}/read`],
  },
  /** Set Filesystem Properties reads the properties first to keep Alchemy's ownership markers. */
  fileSystemWrite: {
    customRole: "DataLakeFileSystemWriteRole",
    description: "Alchemy Data Lake binding: read and write filesystem properties",
    actions: [`${CONTAINERS}/read`, `${CONTAINERS}/write`],
  },
  createFileSystem: {
    customRole: "DataLakeFileSystemCreateRole",
    description: "Alchemy Data Lake binding: create filesystems",
    actions: [`${CONTAINERS}/write`],
  },
  deleteFileSystem: {
    customRole: "DataLakeFileSystemDeleteRole",
    description: "Alchemy Data Lake binding: delete filesystems",
    actions: [`${CONTAINERS}/delete`],
  },
} satisfies Record<string, DataLakeAccess>;

/** Which data-plane endpoint an operation calls. */
export type DataLakeEndpoint = "dfs" | "blob";

/** Where a filesystem lives, resolved per call at runtime. */
export interface FileSystemAddress {
  readonly tag: string;
  /** `https://{account}.dfs.core.windows.net` */
  readonly dfs: Effect.Effect<string>;
  /**
   * `https://{account}.blob.core.windows.net`: Set Expiry, Undelete, and
   * List Blobs are Blob service operations and fail on the `dfs` endpoint.
   */
  readonly blob: Effect.Effect<string>;
  readonly filesystem: Effect.Effect<string>;
}

/** Where a storage account's Data Lake endpoint lives, resolved per call at runtime. */
export interface AccountAddress {
  readonly tag: string;
  /** `https://{account}.dfs.core.windows.net` */
  readonly dfs: Effect.Effect<string>;
}

/**
 * Assign `access` on `scope` (the bound filesystem or account) to the host.
 * A custom role is declared on first use, under its fixed logical ID.
 */
const GrantDataLakeAccess = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Only deploy declares roles, so a host bundle drops the role definition.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: BlobContainer | StorageAccount,
    scope: Input<string>,
    access: DataLakeAccess,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleDefinitionId =
        "builtInRole" in access
          ? access.builtInRole
          : (yield* AzureRoleDefinition(access.customRole, {
              description: access.description,
              permissions: [
                {
                  actions: [...(access.actions ?? [])],
                  dataActions: [...(access.dataActions ?? [])],
                },
              ],
            })).roleDefinitionId;
      yield* bind`${tag}(${resource})`({ roleAssignments: [{ roleDefinitionId, scope }] });
    }
  });
});

/**
 * Build a filesystem binding: assigns `access` on the bound
 * {@link BlobContainer} (a Data Lake filesystem) and returns the client
 * `makeClient` builds.
 */
export const makeFileSystemBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.ReadPath`. */
  tag: string;
  access: DataLakeAccess;
  makeClient: Effect.Effect<(address: FileSystemAddress) => Client>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantDataLakeAccess;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (fileSystem: BlobContainer) {
      yield* grant(options.tag, fileSystem, fileSystem.containerId, options.access);
      const dfs =
        yield* Output.interpolate`https://${fileSystem.storageAccount}.dfs.core.windows.net`;
      const blob =
        yield* Output.interpolate`https://${fileSystem.storageAccount}.blob.core.windows.net`;
      const filesystem = yield* fileSystem.containerName;
      return makeClient({ tag: `${options.tag}(${fileSystem.LogicalId})`, dfs, blob, filesystem });
    });
  });

/**
 * Build a binding for one filesystem-scoped distilled operation: the
 * callable fills in `url` (the `endpoint`) and `filesystem` from the bound
 * {@link BlobContainer} and passes the rest of the request through.
 */
export const makeFileSystemOperationBinding = <
  I extends { url: string; filesystem: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.ReadPath`. */
  tag: string;
  /** The distilled `storage-datalake` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  access: DataLakeAccess;
  /** @default "dfs" */
  endpoint?: DataLakeEndpoint;
}) =>
  makeFileSystemBinding({
    tag: options.tag,
    access: options.access,
    makeClient: Effect.gen(function* () {
      const op = yield* AzureBindings.withCredentials(options.operation);
      return (address: FileSystemAddress) =>
        Effect.fn(address.tag)(function* (request?: Omit<I, "url" | "filesystem">) {
          const url = yield* options.endpoint === "blob" ? address.blob : address.dfs;
          const filesystem = yield* address.filesystem;
          // `I` is `Omit<I, "url" | "filesystem">` plus both; TS cannot
          // rebuild a generic type from an Omit spread.
          return yield* op({ ...request, url, filesystem } as I);
        });
    }),
  });

/**
 * Build a binding for one account-scoped distilled operation (create,
 * delete, or list filesystems): assigns `access` on the bound
 * {@link StorageAccount}, and the callable fills in its `dfs` endpoint as
 * `url`.
 */
export const makeAccountOperationBinding = <I extends { url: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.CreateFileSystem`. */
  tag: string;
  /** The distilled `storage-datalake` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  access: DataLakeAccess;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantDataLakeAccess;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: StorageAccount) {
      yield* grant(options.tag, account, account.storageAccountId, options.access);
      const dfs =
        yield* Output.interpolate`https://${account.storageAccountName}.dfs.core.windows.net`;
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request?: Omit<I, "url">,
      ) {
        const url = yield* dfs;
        // TS cannot rebuild a generic type from an Omit spread.
        return yield* op({ ...request, url } as I);
      });
    });
  });

const dfsAt = (address: FileSystemAddress) =>
  Effect.all({ url: address.dfs, filesystem: address.filesystem });

/** Percent-encode each segment of a path, keeping the `/` separators. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** `x-ms-rename-source` for `source` inside `filesystem`. */
const renameSource = (filesystem: string, source: string) =>
  `/${filesystem}/${encodePath(source.replace(/^\/+/, ""))}`;

/** Split `"n1=v1,n2=v2"` (values base64) into `[name, value]` pairs. */
const parseProperties = (raw: string | undefined): [string, string][] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("="))
    .map((entry) => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)];
    });

/** Read client over `ReadPath`, `GetPathProperties`, and `ListFileSystemPaths`. */
export const makeReadDataLakeClient = Effect.gen(function* () {
  const readPath = yield* AzureBindings.withCredentials(datalake.ReadPath);
  const getPathProperties = yield* AzureBindings.withCredentials(datalake.GetPathProperties);
  const listPaths = yield* AzureBindings.withCredentials(datalake.ListFileSystemPaths);
  return (address: FileSystemAddress): ReadDataLakeFileSystemClient => ({
    read: Effect.fn(`${address.tag}.read`)(function* (path: string) {
      const at = yield* dfsAt(address);
      const file = yield* readPath({ ...at, path }).pipe(
        Effect.catchTag("PathNotFound", () => Effect.succeed(undefined)),
      );
      if (file === undefined) return undefined;
      const body = file.body;
      return {
        path,
        size: body.byteLength,
        contentType: file.contentType,
        etag: file.eTag,
        lastModified: file.lastModified,
        body,
        text: () => new TextDecoder().decode(body),
      };
    }),
    getProperties: Effect.fn(`${address.tag}.getProperties`)(function* (path: string) {
      const at = yield* dfsAt(address);
      const props = yield* getPathProperties({ ...at, path }).pipe(
        Effect.catchTag("PathNotFound", () => Effect.succeed(undefined)),
      );
      if (props === undefined) return undefined;
      return {
        path,
        isDirectory: props.xMsResourceType === "directory",
        size: props.contentLength ?? 0,
        contentType: props.contentType,
        etag: props.eTag,
        lastModified: props.lastModified,
        owner: props.xMsOwner,
        group: props.xMsGroup,
        permissions: props.xMsPermissions,
      };
    }),
    list: Effect.fn(`${address.tag}.list`)(function* (options?: ListDataLakePathsOptions) {
      const at = yield* dfsAt(address);
      const page = yield* listPaths({
        ...at,
        directory: options?.directory,
        recursive: options?.recursive ?? false,
        maxResults: options?.maxResults,
        continuation: options?.continuation,
      });
      return {
        paths: (page.paths ?? []).map((entry): DataLakePathInfo => ({
          path: entry.name ?? "",
          isDirectory: entry.isDirectory === "true",
          size: Number(entry.contentLength ?? 0),
          etag: entry.eTag,
          lastModified: entry.lastModified,
          owner: entry.owner,
          group: entry.group,
          permissions: entry.permissions,
        })),
        continuation: page.xMsContinuation || undefined,
      };
    }),
  });
});

/** Write client over `CreatePath`, `PathAppendData`, `FlushPathData`, and `DeletePath`. */
export const makeWriteDataLakeClient = Effect.gen(function* () {
  const createPath = yield* AzureBindings.withCredentials(datalake.CreatePath);
  const appendData = yield* AzureBindings.withCredentials(datalake.PathAppendData);
  const flushData = yield* AzureBindings.withCredentials(datalake.FlushPathData);
  const deletePath = yield* AzureBindings.withCredentials(datalake.DeletePath);
  return (address: FileSystemAddress): WriteDataLakeFileSystemClient => ({
    createDirectory: Effect.fn(`${address.tag}.createDirectory`)(function* (path: string) {
      const at = yield* dfsAt(address);
      yield* createPath({ ...at, path, resource: "directory" });
    }),
    write: Effect.fn(`${address.tag}.write`)(function* (
      path: string,
      body: string | Uint8Array,
      options?: WriteDataLakeFileOptions,
    ) {
      const at = yield* dfsAt(address);
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      // Create (or truncate) the file, stage the bytes, then commit them.
      yield* createPath({ ...at, path, resource: "file" });
      if (bytes.byteLength > 0) {
        yield* appendData({ ...at, path, position: 0, body: bytes });
      }
      const flushed = yield* flushData({
        ...at,
        path,
        position: bytes.byteLength,
        xMsContentType:
          options?.contentType ??
          (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream"),
      });
      return { etag: flushed.eTag };
    }),
    rename: Effect.fn(`${address.tag}.rename`)(function* (source: string, destination: string) {
      const at = yield* dfsAt(address);
      yield* createPath({
        ...at,
        path: destination,
        xMsRenameSource: renameSource(at.filesystem, source),
      });
    }),
    delete: Effect.fn(`${address.tag}.delete`)(function* (
      path: string,
      options?: DeleteDataLakePathOptions,
    ) {
      const at = yield* dfsAt(address);
      // A large directory can take several calls; each returns the next token.
      let continuation: string | undefined;
      do {
        const deleted = yield* deletePath({
          ...at,
          path,
          recursive: options?.recursive,
          continuation,
        }).pipe(Effect.catchTag("PathNotFound", () => Effect.succeed(undefined)));
        continuation = deleted?.xMsContinuation || undefined;
      } while (continuation !== undefined);
    }),
  });
});

/** `RenamePath` client: `Path_Create` with the rename source filled in. */
export const makeRenamePathClient = Effect.gen(function* () {
  const createPath = yield* AzureBindings.withCredentials(datalake.CreatePath);
  return (address: FileSystemAddress) =>
    Effect.fn(address.tag)(function* ({ source, ...request }: RenamePathRequest) {
      const at = yield* dfsAt(address);
      return yield* createPath({
        ...request,
        ...at,
        xMsRenameSource: renameSource(at.filesystem, source),
      });
    });
});

/** `SetPathProperties` client: `Path_Update` with `action=setProperties`. */
export const makeSetPathPropertiesClient = Effect.gen(function* () {
  const updatePath = yield* AzureBindings.withCredentials(datalake.UpdatePath);
  return (address: FileSystemAddress) =>
    Effect.fn(address.tag)(function* (request: SetPathPropertiesRequest) {
      const at = yield* dfsAt(address);
      return yield* updatePath({
        ...request,
        ...at,
        action: "setProperties",
        // The swagger marks `mode` and `body` required for every action;
        // setProperties ignores `mode` and sends no body.
        mode: "set",
        body: new Uint8Array(),
      });
    });
});

/**
 * `SetFileSystemProperties` client: reads the current properties first and
 * keeps the `alchemy_*` ownership markers the `BlobContainer` resource
 * stores there.
 */
export const makeSetFileSystemPropertiesClient = Effect.gen(function* () {
  const getProperties = yield* AzureBindings.withCredentials(datalake.GetFileSystemProperties);
  const setProperties = yield* AzureBindings.withCredentials(datalake.SetFileSystemProperties);
  return (address: FileSystemAddress) =>
    Effect.fn(address.tag)(function* (request?: SetFileSystemPropertiesRequest) {
      const at = yield* dfsAt(address);
      const current = yield* getProperties(at);
      const markers = parseProperties(current.xMsProperties).filter(([name]) =>
        name.startsWith("alchemy_"),
      );
      const requested = parseProperties(request?.xMsProperties).filter(
        ([name]) => !name.startsWith("alchemy_"),
      );
      const properties = [...markers, ...requested].map(([name, value]) => `${name}=${value}`);
      return yield* setProperties({
        ...request,
        ...at,
        xMsProperties: properties.length > 0 ? properties.join(",") : undefined,
      });
    });
});
