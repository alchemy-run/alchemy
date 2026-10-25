import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { BlobContainer } from "./BlobContainer.ts";
import type { ReadBlobContainerClient } from "./BlobContainerRead.ts";
import type {
  BlobOperationRequest,
  BlobProperties,
  ListBlobsOptions,
  PutBlobOptions,
} from "./BlobContainerTypes.ts";
import type { WriteBlobContainerClient } from "./BlobContainerWrite.ts";
import type { StorageAccount } from "./StorageAccount.ts";

/**
 * Shared scaffolding for the blob container bindings: the per-operation
 * bindings (`DownloadBlob`, `UploadBlockBlob`, …) and the
 * Read/Write/ReadWrite clients. It resolves the distilled `storage-blob`
 * operations once when the layer is built and, at deploy time, assigns the
 * binding's role on the bound container.
 *
 * NOT exported from `index.ts`.
 */

const SERVICE = "Microsoft.Storage/storageAccounts/blobServices";
const CONTAINERS = `${SERVICE}/containers`;
const BLOBS = `${CONTAINERS}/blobs`;

/**
 * A custom RBAC role a blob binding creates once per stack (an
 * `Azure.Authorization.RoleDefinition` at the subscription, assigned only on
 * the bound container) when the smallest built-in role grants more than the
 * operation needs.
 */
export interface BlobCustomRole {
  /** Logical ID suffix, e.g. `BlobWriter` → `AzureStorageBlobWriterRole`. */
  readonly name: string;
  readonly description: string;
  readonly actions?: readonly string[];
  readonly dataActions?: readonly string[];
}

/** The role a blob binding assigns: a built-in role GUID or a custom role. */
export type BlobRole = string | BlobCustomRole;

/**
 * The roles the blob bindings assign. Built-in **Storage Blob Data Reader**
 * already holds only `blobs/read` (plus `containers/read`); every other
 * operation gets a custom role with exactly the permissions Azure Storage
 * checks for it
 * (https://learn.microsoft.com/rest/api/storageservices/authorize-with-azure-active-directory#permissions-for-blob-service-operations).
 */
export const BlobRoles = {
  Reader: BuiltInRole.StorageBlobDataReader,
  Writer: {
    name: "BlobWriter",
    description: "Alchemy blob binding: write blobs (blobs/write).",
    dataActions: [`${BLOBS}/write`],
  },
  Copier: {
    name: "BlobCopier",
    description: "Alchemy blob binding: copy blobs within a container (blobs/read, blobs/write).",
    dataActions: [`${BLOBS}/read`, `${BLOBS}/write`],
  },
  Deleter: {
    name: "BlobDeleter",
    description: "Alchemy blob binding: delete blobs (blobs/delete).",
    dataActions: [`${BLOBS}/delete`],
  },
  TagReader: {
    name: "BlobTagReader",
    description: "Alchemy blob binding: read blob index tags (blobs/tags/read).",
    dataActions: [`${BLOBS}/tags/read`],
  },
  TagWriter: {
    name: "BlobTagWriter",
    description: "Alchemy blob binding: write blob index tags (blobs/tags/write).",
    dataActions: [`${BLOBS}/tags/write`],
  },
  TagFilter: {
    name: "BlobTagFilter",
    description: "Alchemy blob binding: find blobs by index tags (blobs/filter/action).",
    dataActions: [`${BLOBS}/filter/action`],
  },
  ImmutabilityAdmin: {
    name: "BlobImmutabilityAdmin",
    description:
      "Alchemy blob binding: set and delete blob immutability policies (blobs/immutableStorage/runAsSuperUser/action).",
    dataActions: [`${BLOBS}/immutableStorage/runAsSuperUser/action`],
  },
  ContainerReader: {
    name: "BlobContainerReader",
    description: "Alchemy blob binding: read container properties (containers/read).",
    actions: [`${CONTAINERS}/read`],
  },
  ContainerWriter: {
    name: "BlobContainerWriter",
    description:
      "Alchemy blob binding: container metadata, container leases, legal holds, undelete (containers/write).",
    actions: [`${CONTAINERS}/write`],
  },
  ContainerDeleter: {
    name: "BlobContainerDeleter",
    description: "Alchemy blob binding: delete containers (containers/delete).",
    actions: [`${CONTAINERS}/delete`],
  },
  ServiceReader: {
    name: "BlobServiceReader",
    description:
      "Alchemy blob binding: read Blob service properties and statistics (blobServices/read).",
    actions: [`${SERVICE}/read`],
  },
  ServiceWriter: {
    name: "BlobServiceWriter",
    description: "Alchemy blob binding: set Blob service properties (blobServices/write).",
    actions: [`${SERVICE}/write`],
  },
  ContainerAclReader: {
    name: "BlobContainerAclReader",
    description:
      "Alchemy blob binding: read a container's access policy (containers/getAcl/action).",
    actions: [`${CONTAINERS}/getAcl/action`],
  },
  ContainerAclWriter: {
    name: "BlobContainerAclWriter",
    description:
      "Alchemy blob binding: set a container's access policy (containers/setAcl/action).",
    actions: [`${CONTAINERS}/setAcl/action`],
  },
} as const satisfies Record<string, BlobRole>;

/** Where a container's blobs live, resolved per call at runtime. */
interface ContainerAddress {
  readonly tag: string;
  /** `https://{account}.blob.core.windows.net` */
  readonly url: Effect.Effect<string>;
  readonly containerName: Effect.Effect<string>;
}

/** Assign `role` on the bound container or account, creating a custom role once per stack. */
const GrantOnScope = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Custom roles are deploy-time resources.
  const defineRole = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: BlobContainer | StorageAccount,
    scope: Output.Output<string>,
    role: BlobRole,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && defineRole !== undefined) {
      // One role per permission set, shared by every host in the stack.
      const roleDefinitionId =
        typeof role === "string"
          ? role
          : (yield* defineRole(`AzureStorage${role.name}Role`, {
              description: role.description,
              permissions: [
                {
                  actions: [...(role.actions ?? [])],
                  dataActions: [...(role.dataActions ?? [])],
                },
              ],
            })).roleDefinitionId;
      yield* bind`${tag}(${resource})`({
        roleAssignments: [{ roleDefinitionId, scope }],
      });
    }
  });
});

const GrantOnContainer = Effect.gen(function* () {
  const grant = yield* GrantOnScope;
  return (tag: string, container: BlobContainer, role: BlobRole) =>
    grant(tag, container, container.containerId, role);
});

const addressOf = Effect.fn(function* (tag: string, container: BlobContainer) {
  const url = yield* Output.interpolate`https://${container.storageAccount}.blob.core.windows.net`;
  const containerName = yield* container.containerName;
  return { tag: `${tag}(${container.LogicalId})`, url, containerName } satisfies ContainerAddress;
});

const at = (address: ContainerAddress) =>
  Effect.all({ url: address.url, containerName: address.containerName });

type ContainerScoped = { url: string; containerName: string };

/**
 * Build the impl Effect for a container-scoped operation: the runtime
 * callable injects the bound container's `url` and `containerName`, and the
 * deploy-time half assigns `role` on the container.
 */
export const makeBlobContainerOpBinding = <I extends ContainerScoped, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.DownloadBlob`. */
  tag: string;
  /** The distilled `storage-blob` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The role assigned on the container. */
  role: BlobRole;
}) =>
  Effect.gen(function* () {
    const grantOnContainer = yield* GrantOnContainer;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (container: BlobContainer) {
      yield* grantOnContainer(options.tag, container, options.role);
      const address = yield* addressOf(options.tag, container);
      return Effect.fn(address.tag)(function* (request?: Omit<I, keyof ContainerScoped>) {
        const where = yield* at(address);
        return yield* op({ ...request, ...where } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-scoped Blob service operation (list,
 * create, delete, or restore containers; service properties; account-wide
 * tag search): the runtime callable injects the bound account's Blob
 * endpoint as `url` (its `-secondary` endpoint for `secondary`), and the
 * deploy-time half assigns `role` on the account.
 */
export const makeBlobServiceOpBinding = <I extends { url: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.ListBlobContainers`. */
  tag: string;
  /** The distilled `storage-blob` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The role assigned on the account. */
  role: BlobRole;
  /** Call the read-access geo-redundant secondary endpoint. */
  secondary?: boolean;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnScope;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: StorageAccount) {
      yield* grant(options.tag, account, account.storageAccountId, options.role);
      const suffix = options.secondary ? "-secondary" : "";
      const url =
        yield* Output.interpolate`https://${account.storageAccountName}${suffix}.blob.core.windows.net`;
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request?: Omit<I, "url">,
      ) {
        const endpoint = yield* url;
        return yield* op({ ...request, url: endpoint } as I);
      });
    });
  });

export const makeBlobContainerHelpers = Effect.gen(function* () {
  // Resolve operations one at a time (see `AzureBindings.withCredentials`).
  const download = yield* AzureBindings.withCredentials(blob.DownloadBlob);
  const getProperties = yield* AzureBindings.withCredentials(blob.GetBlobProperties);
  const list = yield* AzureBindings.withCredentials(blob.ListContainerBlobFlatSegment);
  const listByHierarchy = yield* AzureBindings.withCredentials(
    blob.ListContainerBlobHierarchySegment,
  );
  const getBlockList = yield* AzureBindings.withCredentials(blob.BlockBlobGetBlockList);
  const getPageRanges = yield* AzureBindings.withCredentials(blob.GetPageBlobPageRanges);
  const getPageRangesDiff = yield* AzureBindings.withCredentials(blob.GetPageBlobPageRangesDiff);
  const query = yield* AzureBindings.withCredentials(blob.BlobQuery);
  const getContainerProperties = yield* AzureBindings.withCredentials(blob.GetContainerProperties);

  const upload = yield* AzureBindings.withCredentials(blob.UploadBlockBlob);
  const remove = yield* AzureBindings.withCredentials(blob.DeleteBlob);
  const stageBlock = yield* AzureBindings.withCredentials(blob.BlockBlobStageBlock);
  const commitBlockList = yield* AzureBindings.withCredentials(blob.ListBlockBlobCommitBlock);
  const createAppendBlob = yield* AzureBindings.withCredentials(blob.CreateAppendBlob);
  const appendBlock = yield* AzureBindings.withCredentials(blob.BlockAppendBlobAppend);
  const sealAppendBlob = yield* AzureBindings.withCredentials(blob.SealAppendBlob);
  const createPageBlob = yield* AzureBindings.withCredentials(blob.CreatePageBlob);
  const uploadPages = yield* AzureBindings.withCredentials(blob.UploadPageBlobPages);
  const clearPages = yield* AzureBindings.withCredentials(blob.ClearPageBlobPages);
  const resizePageBlob = yield* AzureBindings.withCredentials(blob.ResizePageBlob);
  const updateSequenceNumber = yield* AzureBindings.withCredentials(
    blob.UpdatePageBlobSequenceNumber,
  );
  const setHttpHeaders = yield* AzureBindings.withCredentials(blob.SetBlobHTTPHeaders);
  const setMetadata = yield* AzureBindings.withCredentials(blob.SetBlobMetadata);
  const setTier = yield* AzureBindings.withCredentials(blob.SetBlobTier);
  const createSnapshot = yield* AzureBindings.withCredentials(blob.CreateBlobSnapshot);
  const acquireLease = yield* AzureBindings.withCredentials(blob.BlobAcquireLease);
  const releaseLease = yield* AzureBindings.withCredentials(blob.BlobReleaseLease);
  const renewLease = yield* AzureBindings.withCredentials(blob.RenewBlobLease);
  const changeLease = yield* AzureBindings.withCredentials(blob.BlobChangeLease);
  const breakLease = yield* AzureBindings.withCredentials(blob.BlobBreakLease);
  const startCopy = yield* AzureBindings.withCredentials(blob.BlobStartCopyFromURL);
  const copyFromUrl = yield* AzureBindings.withCredentials(blob.CopyBlobFromURL);
  const putFromUrl = yield* AzureBindings.withCredentials(blob.PutBlockBlobBlobFromUrl);
  const abortCopy = yield* AzureBindings.withCredentials(blob.BlobAbortCopyFromURL);
  const undelete = yield* AzureBindings.withCredentials(blob.UndeleteBlob);
  const setContainerMetadata = yield* AzureBindings.withCredentials(blob.SetContainerMetadata);

  /** A per-blob method: `(key, options)` → the operation on that blob. */
  const onBlob =
    <I extends ContainerScoped & { blob: string }, A, E>(
      address: ContainerAddress,
      name: string,
      op: (input: I) => Effect.Effect<A, E>,
    ) =>
    (key: string, options?: BlobOperationRequest<I>) =>
      at(address).pipe(
        Effect.flatMap((where) => op({ ...options, ...where, blob: key } as I)),
        Effect.withSpan(`${address.tag}.${name}`),
      );

  /** A container method: `(options)` → the operation on the container. */
  const onContainer =
    <I extends ContainerScoped, A, E>(
      address: ContainerAddress,
      name: string,
      op: (input: I) => Effect.Effect<A, E>,
    ) =>
    (options?: Omit<I, keyof ContainerScoped>) =>
      at(address).pipe(
        Effect.flatMap((where) => op({ ...options, ...where } as I)),
        Effect.withSpan(`${address.tag}.${name}`),
      );

  const makeRead = (address: ContainerAddress): ReadBlobContainerClient => ({
    get: Effect.fn(`${address.tag}.get`)(function* (key: string) {
      const where = yield* at(address);
      const res = yield* download({ ...where, blob: key }).pipe(
        Effect.catchTag("BlobNotFound", () => Effect.succeed(undefined)),
      );
      if (res === undefined) return undefined;
      const body = res.body;
      return {
        key,
        size: body.byteLength,
        contentType: res.contentType,
        etag: res.eTag,
        lastModified: res.lastModified,
        body,
        text: () => new TextDecoder().decode(body),
      };
    }),
    head: Effect.fn(`${address.tag}.head`)(function* (key: string) {
      const where = yield* at(address);
      const res = yield* getProperties({ ...where, blob: key }).pipe(
        Effect.catchTag("BlobNotFound", () => Effect.succeed(undefined)),
      );
      if (res === undefined) return undefined;
      return {
        key,
        size: res.contentLength ?? 0,
        contentType: res.contentType,
        etag: res.eTag,
        lastModified: res.lastModified,
      } satisfies BlobProperties;
    }),
    list: Effect.fn(`${address.tag}.list`)(function* (options?: ListBlobsOptions) {
      const where = yield* at(address);
      const page = yield* list({
        ...where,
        prefix: options?.prefix,
        marker: options?.marker,
        maxresults: options?.maxResults,
      });
      return {
        blobs: (page.Segment?.BlobItems ?? []).map((item): BlobProperties => ({
          key: item.Name?.content ?? "",
          size: item.Properties?.Content_Length ?? 0,
          contentType: item.Properties?.Content_Type || undefined,
          etag: item.Properties?.Etag,
          lastModified: item.Properties?.Last_Modified,
        })),
        nextMarker: page.NextMarker || undefined,
      };
    }),
    listByHierarchy: onContainer(address, "listByHierarchy", listByHierarchy),
    getBlockList: onBlob(address, "getBlockList", getBlockList),
    getPageRanges: onBlob(address, "getPageRanges", getPageRanges),
    getPageRangesDiff: onBlob(address, "getPageRangesDiff", getPageRangesDiff),
    query: onBlob(address, "query", query),
    getContainerProperties: onContainer(address, "getContainerProperties", getContainerProperties),
  });

  const makeWrite = (address: ContainerAddress): WriteBlobContainerClient => ({
    put: Effect.fn(`${address.tag}.put`)(function* (
      key: string,
      body: string | Uint8Array,
      options?: PutBlobOptions,
    ) {
      const where = yield* at(address);
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const res = yield* upload({
        ...where,
        blob: key,
        body: bytes,
        xMsBlobContentType:
          options?.contentType ??
          (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream"),
      });
      return { etag: res.eTag };
    }),
    delete: Effect.fn(`${address.tag}.delete`)(function* (key: string) {
      const where = yield* at(address);
      yield* remove({ ...where, blob: key }).pipe(
        Effect.catchTag("BlobNotFound", () => Effect.void),
      );
    }),
    stageBlock: onBlob(address, "stageBlock", stageBlock),
    commitBlockList: onBlob(address, "commitBlockList", commitBlockList),
    createAppendBlob: onBlob(address, "createAppendBlob", createAppendBlob),
    appendBlock: onBlob(address, "appendBlock", appendBlock),
    sealAppendBlob: onBlob(address, "sealAppendBlob", sealAppendBlob),
    createPageBlob: onBlob(address, "createPageBlob", createPageBlob),
    uploadPages: onBlob(address, "uploadPages", uploadPages),
    clearPages: onBlob(address, "clearPages", clearPages),
    resizePageBlob: onBlob(address, "resizePageBlob", resizePageBlob),
    updateSequenceNumber: onBlob(address, "updateSequenceNumber", updateSequenceNumber),
    setHttpHeaders: onBlob(address, "setHttpHeaders", setHttpHeaders),
    setMetadata: onBlob(address, "setMetadata", setMetadata),
    setTier: onBlob(address, "setTier", setTier),
    createSnapshot: onBlob(address, "createSnapshot", createSnapshot),
    acquireLease: onBlob(address, "acquireLease", acquireLease),
    releaseLease: onBlob(address, "releaseLease", releaseLease),
    renewLease: onBlob(address, "renewLease", renewLease),
    changeLease: onBlob(address, "changeLease", changeLease),
    breakLease: onBlob(address, "breakLease", breakLease),
    startCopy: onBlob(address, "startCopy", startCopy),
    copyFromUrl: onBlob(address, "copyFromUrl", copyFromUrl),
    putFromUrl: onBlob(address, "putFromUrl", putFromUrl),
    abortCopy: onBlob(address, "abortCopy", abortCopy),
    undelete: onBlob(address, "undelete", undelete),
    setContainerMetadata: onContainer(address, "setContainerMetadata", setContainerMetadata),
  });

  return { makeRead, makeWrite };
});

/**
 * Build a blob container binding that assigns `role` on the container and
 * returns `makeClient`'s client.
 */
export const makeBlobContainerBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.BlobContainerRead`. */
  tag: string;
  /** Built-in role GUID assigned on the container. */
  role: string;
  makeClient: (
    helpers: Effect.Success<typeof makeBlobContainerHelpers>,
    address: ContainerAddress,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const grantOnContainer = yield* GrantOnContainer;
    const helpers = yield* makeBlobContainerHelpers;
    return Effect.fn(function* (container: BlobContainer) {
      yield* grantOnContainer(options.tag, container, options.role);
      const address = yield* addressOf(options.tag, container);
      return options.makeClient(helpers, address);
    });
  });
