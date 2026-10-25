import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as AzureBindings from "../AzureBindings.ts";
import type { BlobContainer } from "./BlobContainer.ts";
import type { ReadBlobContainerClient } from "./BlobContainerRead.ts";
import type { BlobProperties, ListBlobsOptions, PutBlobOptions } from "./BlobContainerTypes.ts";
import type { WriteBlobContainerClient } from "./BlobContainerWrite.ts";

/**
 * Shared scaffolding for the blob container Read/Write/ReadWrite bindings:
 * resolves the distilled `storage-blob` operations once when the layer is
 * built and assigns `role` on the bound container at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Where a container's blobs live, resolved per call at runtime. */
interface ContainerAddress {
  readonly tag: string;
  /** `https://{account}.blob.core.windows.net` */
  readonly url: Effect.Effect<string>;
  readonly containerName: Effect.Effect<string>;
}

const GrantOnContainer = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  return Effect.fn(function* (tag: string, container: BlobContainer, role: string) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bind`${tag}(${container})`({
        roleAssignments: [{ roleDefinitionId: role, scope: container.containerId }],
      });
    }
  });
});

export const makeBlobContainerHelpers = Effect.gen(function* () {
  const download = yield* AzureBindings.withCredentials(blob.DownloadBlob);
  const getProperties = yield* AzureBindings.withCredentials(blob.GetBlobProperties);
  const list = yield* AzureBindings.withCredentials(blob.ListContainerBlobFlatSegment);
  const upload = yield* AzureBindings.withCredentials(blob.UploadBlockBlob);
  const remove = yield* AzureBindings.withCredentials(blob.DeleteBlob);

  const at = (address: ContainerAddress) =>
    Effect.all({ url: address.url, containerName: address.containerName });

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
      const url =
        yield* Output.interpolate`https://${container.storageAccount}.blob.core.windows.net`;
      const containerName = yield* container.containerName;
      return options.makeClient(helpers, {
        tag: `${options.tag}(${container.LogicalId})`,
        url,
        containerName,
      });
    });
  });
