import * as files from "@distilled.cloud/azure/storage-file";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { FileShare } from "./FileShare.ts";
import type { ReadFileShareClient } from "./FileShareRead.ts";
import type {
  FileShareRequest,
  ListShareFilesOptions,
  PutShareFileOptions,
  ShareFileProperties,
} from "./FileShareTypes.ts";
import type { WriteFileShareClient } from "./FileShareWrite.ts";

/**
 * Shared scaffolding for the file share bindings: resolves the distilled
 * `storage-file` operations once when the layer is built and grants the
 * share-scoped roles at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/**
 * What a binding does on the share. Each level maps to one role on the
 * share, the smallest that allows it:
 *
 * - `read`: built-in Storage File Data Privileged Reader (`files/read` +
 *   `readFileBackupSemantics/action`, exactly what reads need);
 * - `write` / `delete`: a custom role per stack, because the built-in
 *   Privileged Contributor also grants read, delete and ACL changes.
 */
export type FileShareAccess = "read" | "write" | "delete";

const FILE_SERVICES = "Microsoft.Storage/storageAccounts/fileServices";

/** Custom roles, one per stack, shared by every host and share. */
const CUSTOM_ROLES = {
  write: {
    id: "AzureStorageFileShareWriter",
    description:
      "Create files and directories and write ranges in Azure file shares over REST (Alchemy FileShare bindings).",
    dataActions: [
      `${FILE_SERVICES}/fileshares/files/write`,
      `${FILE_SERVICES}/writeFileBackupSemantics/action`,
    ],
  },
  delete: {
    id: "AzureStorageFileShareDeleter",
    description:
      "Delete files and directories in Azure file shares over REST (Alchemy FileShare bindings).",
    dataActions: [
      `${FILE_SERVICES}/fileshares/files/delete`,
      `${FILE_SERVICES}/writeFileBackupSemantics/action`,
    ],
  },
} as const;

/**
 * Azure Files data roles are assigned on the share's data-plane scope
 * (`…/fileServices/default/fileshares/{name}`), not its ARM ID
 * (`…/fileServices/default/shares/{name}`).
 */
const dataScopeOf = (share: FileShare) =>
  share.shareId.pipe(Output.map((id) => id.replace(/\/shares\/([^/]+)$/i, "/fileshares/$1")));

const GrantOnShare = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Deploy only: a host bundle never declares role definitions.
  const defineRole = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, share: FileShare, access: readonly FileShareAccess[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && defineRole !== undefined) {
      const scope = dataScopeOf(share);
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const level of access) {
        if (level === "read") {
          roleAssignments.push({
            roleDefinitionId: BuiltInRole.StorageFileDataPrivilegedReader,
            scope,
          });
          continue;
        }
        const custom = CUSTOM_ROLES[level];
        const role = yield* defineRole(custom.id, {
          description: custom.description,
          permissions: [{ dataActions: [...custom.dataActions] }],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope });
      }
      yield* bind`${tag}(${share})`({ roleAssignments });
    }
  });
});

/** Where a share's files live, resolved per call at runtime. */
export interface ShareAddress {
  readonly tag: string;
  /** `https://{account}.file.core.windows.net` */
  readonly url: Effect.Effect<string>;
  readonly shareName: Effect.Effect<string>;
}

const at = (address: ShareAddress) =>
  Effect.all({ url: address.url, shareName: address.shareName }).pipe(
    // Entra-token calls to the File REST API must declare backup intent.
    Effect.map((where) => ({ ...where, xMsFileRequestIntent: "backup" as const })),
  );

const addressOf = Effect.fn(function* (tag: string, share: FileShare) {
  const url = yield* Output.interpolate`https://${share.storageAccount}.file.core.windows.net`;
  const shareName = yield* share.shareName;
  return { tag: `${tag}(${share.LogicalId})`, url, shareName } satisfies ShareAddress;
});

/** Split `a/b/c.txt` into its parent directory paths: `["a", "a/b"]`. */
const parentsOf = (path: string) => {
  const parts = normalize(path).split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** Drop leading/trailing and repeated `/`. */
const normalize = (path: string) => path.split("/").filter(Boolean).join("/");

/** Largest range one `Put Range` call accepts (4 MiB). */
const MAX_RANGE = 4 * 1024 * 1024;

export const makeFileShareHelpers = Effect.gen(function* () {
  const download = yield* AzureBindings.withCredentials(files.DownloadFile);
  const getProperties = yield* AzureBindings.withCredentials(files.GetFileProperties);
  const list = yield* AzureBindings.withCredentials(files.DirectoryListFilesAndDirectoriesSegment);
  const create = yield* AzureBindings.withCredentials(files.CreateFile);
  const uploadRange = yield* AzureBindings.withCredentials(files.UploadFileRange);
  const remove = yield* AzureBindings.withCredentials(files.DeleteFile);
  const mkdir = yield* AzureBindings.withCredentials(files.CreateDirectory);
  const rmdir = yield* AzureBindings.withCredentials(files.DeleteDirectory);

  const makeRead = (address: ShareAddress): ReadFileShareClient => ({
    get: Effect.fn(`${address.tag}.get`)(function* (path: string) {
      const where = yield* at(address);
      const fileName = normalize(path);
      const res = yield* download({ ...where, fileName }).pipe(
        Effect.catchTag(["ResourceNotFound", "ParentNotFound"], () => Effect.succeed(undefined)),
      );
      if (res === undefined) return undefined;
      const body = res.body;
      return {
        path: fileName,
        size: body.byteLength,
        contentType: res.contentType,
        etag: res.eTag,
        lastModified: res.lastModified,
        body,
        text: () => new TextDecoder().decode(body),
      };
    }),
    head: Effect.fn(`${address.tag}.head`)(function* (path: string) {
      const where = yield* at(address);
      const fileName = normalize(path);
      const res = yield* getProperties({ ...where, fileName }).pipe(
        Effect.catchTag(["ResourceNotFound", "ParentNotFound"], () => Effect.succeed(undefined)),
      );
      if (res === undefined) return undefined;
      return {
        path: fileName,
        size: res.contentLength ?? 0,
        contentType: res.contentType,
        etag: res.eTag,
        lastModified: res.lastModified,
      } satisfies ShareFileProperties;
    }),
    list: Effect.fn(`${address.tag}.list`)(function* (options?: ListShareFilesOptions) {
      const where = yield* at(address);
      const directory = normalize(options?.directory ?? "");
      const prefixed = (name: string) => (directory === "" ? name : `${directory}/${name}`);
      const page = yield* list({
        ...where,
        directory,
        prefix: options?.prefix,
        marker: options?.marker,
        maxresults: options?.maxResults,
      });
      return {
        files: page.Segment.FileItems.map((item) => ({
          path: prefixed(item.Name.content ?? ""),
          size: item.Properties?.Content_Length,
        })),
        directories: page.Segment.DirectoryItems.map((item) => prefixed(item.Name.content ?? "")),
        nextMarker: page.NextMarker || undefined,
      };
    }),
  });

  const createDirectory = (address: ShareAddress, path: string) =>
    Effect.gen(function* () {
      const where = yield* at(address);
      for (const directory of [...parentsOf(path), normalize(path)]) {
        if (directory === "") continue;
        yield* mkdir({ ...where, directory }).pipe(
          Effect.catchTag("StorageResourceAlreadyExists", () => Effect.void),
        );
      }
    });

  const makeWrite = (address: ShareAddress): WriteFileShareClient => ({
    put: Effect.fn(`${address.tag}.put`)(function* (
      path: string,
      body: string | Uint8Array,
      options?: PutShareFileOptions,
    ) {
      const where = yield* at(address);
      const fileName = normalize(path);
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const createFile = create({
        ...where,
        fileName,
        xMsContentLength: bytes.byteLength,
        xMsContentType:
          options?.contentType ??
          (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream"),
      });
      // Create File replaces an existing file; a missing parent directory
      // is created on demand.
      const created = yield* createFile.pipe(
        Effect.catchTag("ParentNotFound", () =>
          Effect.andThen(createDirectory(address, parentsOf(fileName).at(-1) ?? ""), createFile),
        ),
      );
      let etag = created.eTag;
      for (let start = 0; start < bytes.byteLength; start += MAX_RANGE) {
        const chunk = bytes.subarray(start, Math.min(start + MAX_RANGE, bytes.byteLength));
        const written = yield* uploadRange({
          ...where,
          fileName,
          xMsRange: `bytes=${start}-${start + chunk.byteLength - 1}`,
          xMsWrite: "update",
          body: chunk,
        });
        etag = written.eTag;
      }
      return { etag };
    }),
    delete: Effect.fn(`${address.tag}.delete`)(function* (path: string) {
      const where = yield* at(address);
      yield* remove({ ...where, fileName: normalize(path) }).pipe(
        Effect.catchTag(["ResourceNotFound", "ParentNotFound"], () => Effect.void),
      );
    }),
    createDirectory: Effect.fn(`${address.tag}.createDirectory`)(function* (path: string) {
      yield* createDirectory(address, path);
    }),
    deleteDirectory: Effect.fn(`${address.tag}.deleteDirectory`)(function* (path: string) {
      const where = yield* at(address);
      yield* rmdir({ ...where, directory: normalize(path) }).pipe(
        Effect.catchTag(["ResourceNotFound", "ParentNotFound"], () => Effect.void),
      );
    }),
  });

  return { makeRead, makeWrite };
});

/**
 * Build a file share binding that grants `access` on the share and returns
 * `makeClient`'s client.
 */
export const makeFileShareBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.FileShareRead`. */
  tag: string;
  /** What the client does on the share; one role per level. */
  access: readonly FileShareAccess[];
  makeClient: (
    helpers: Effect.Success<typeof makeFileShareHelpers>,
    address: ShareAddress,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const grantOnShare = yield* GrantOnShare;
    const helpers = yield* makeFileShareHelpers;
    return Effect.fn(function* (share: FileShare) {
      yield* grantOnShare(options.tag, share, options.access);
      const address = yield* addressOf(options.tag, share);
      return options.makeClient(helpers, address);
    });
  });

/**
 * Build a per-operation file share binding: the runtime callable takes the
 * distilled request without `url`, `shareName` and `xMsFileRequestIntent`,
 * which the bound share supplies, and the deploy-time half grants `access`
 * on the share.
 */
export const makeFileShareOperationBinding = <
  I extends { url: string; shareName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.DownloadFile`. */
  tag: string;
  /** The distilled `storage-file` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** What the operation does on the share. */
  access: FileShareAccess;
}) =>
  Effect.gen(function* () {
    const grantOnShare = yield* GrantOnShare;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (share: FileShare) {
      yield* grantOnShare(options.tag, share, [options.access]);
      const address = yield* addressOf(options.tag, share);
      return Effect.fn(address.tag)(function* (request: FileShareRequest<I>) {
        const where = yield* at(address);
        // `FileShareRequest<I>` plus the three omitted members is `I`; TS
        // cannot prove an `Omit` round-trip over a generic.
        return yield* op({ ...request, ...where } as unknown as I);
      });
    });
  });
