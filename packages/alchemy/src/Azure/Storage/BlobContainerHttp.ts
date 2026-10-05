import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Output from "../../Output.ts";
import {
  azureDataPlaneRequest,
  bindAzureHost,
  envSuffix,
  xmlElements,
  xmlField,
} from "../Binding.ts";
import type { BlobContainer } from "./BlobContainer.ts";
import type { ReadBlobContainerClient } from "./BlobContainerRead.ts";
import type {
  BlobProperties,
  ListBlobsOptions,
  PutBlobOptions,
} from "./BlobContainerTypes.ts";
import type { WriteBlobContainerClient } from "./BlobContainerWrite.ts";

/**
 * Shared HTTP scaffolding for blob container bindings. NOT exported from
 * `index.ts`.
 */

const STORAGE_SCOPE = "https://storage.azure.com/.default";
const STORAGE_VERSION = "2023-11-03";

/** Per-container request context handed to the client builders. */
export interface BlobContainerHttpContext {
  readonly tag: string;
  readonly http: HttpClient.HttpClient;
  /** `https://{account}.blob.core.windows.net/{container}`, resolved per call. */
  readonly containerUrl: Effect.Effect<string>;
}

const encodeKey = (key: string) =>
  key.split("/").map(encodeURIComponent).join("/");

const send = (
  ctx: BlobContainerHttpContext,
  request: HttpClientRequest.HttpClientRequest,
  allow?: readonly number[],
) =>
  azureDataPlaneRequest(
    ctx.http,
    STORAGE_SCOPE,
    request.pipe(HttpClientRequest.setHeader("x-ms-version", STORAGE_VERSION)),
    { allow },
  );

const propertiesOf = (
  key: string,
  headers: Readonly<Record<string, string>>,
): BlobProperties => ({
  key,
  size: Number(headers["content-length"] ?? 0),
  contentType: headers["content-type"],
  etag: headers["etag"],
  lastModified: headers["last-modified"],
});

export const makeReadBlobContainerClient = (ctx: BlobContainerHttpContext) =>
  ({
    get: Effect.fn(`${ctx.tag}.get`)(function* (key: string) {
      const base = yield* ctx.containerUrl;
      const res = yield* send(
        ctx,
        HttpClientRequest.get(`${base}/${encodeKey(key)}`),
        [404],
      );
      if (res.status === 404) return undefined;
      const body = res.bytes;
      return {
        ...propertiesOf(key, res.headers),
        size: body.byteLength,
        body,
        text: () => new TextDecoder().decode(body),
      };
    }),
    head: Effect.fn(`${ctx.tag}.head`)(function* (key: string) {
      const base = yield* ctx.containerUrl;
      const res = yield* send(
        ctx,
        HttpClientRequest.head(`${base}/${encodeKey(key)}`),
        [404],
      );
      return res.status === 404 ? undefined : propertiesOf(key, res.headers);
    }),
    list: Effect.fn(`${ctx.tag}.list`)(function* (options?: ListBlobsOptions) {
      const base = yield* ctx.containerUrl;
      const res = yield* send(
        ctx,
        HttpClientRequest.get(base).pipe(
          HttpClientRequest.setUrlParams({
            restype: "container",
            comp: "list",
            ...(options?.prefix ? { prefix: options.prefix } : {}),
            ...(options?.marker ? { marker: options.marker } : {}),
            ...(options?.maxResults
              ? { maxresults: String(options.maxResults) }
              : {}),
          }),
        ),
      );
      const blobs = xmlElements(res.text, "Blob").map((blob) => ({
        key: xmlField(blob, "Name") ?? "",
        size: Number(xmlField(blob, "Content-Length") ?? 0),
        contentType: xmlField(blob, "Content-Type") || undefined,
        etag: xmlField(blob, "Etag"),
        lastModified: xmlField(blob, "Last-Modified"),
      }));
      const nextMarker = xmlField(res.text, "NextMarker");
      return { blobs, nextMarker: nextMarker || undefined };
    }),
  }) satisfies ReadBlobContainerClient;

export const makeWriteBlobContainerClient = (ctx: BlobContainerHttpContext) =>
  ({
    put: Effect.fn(`${ctx.tag}.put`)(function* (
      key: string,
      body: string | Uint8Array,
      options?: PutBlobOptions,
    ) {
      const base = yield* ctx.containerUrl;
      const contentType =
        options?.contentType ??
        (typeof body === "string"
          ? "text/plain; charset=utf-8"
          : "application/octet-stream");
      const request = HttpClientRequest.put(`${base}/${encodeKey(key)}`).pipe(
        HttpClientRequest.setHeader("x-ms-blob-type", "BlockBlob"),
      );
      const res = yield* send(
        ctx,
        typeof body === "string"
          ? HttpClientRequest.bodyText(request, body, contentType)
          : HttpClientRequest.bodyUint8Array(request, body, contentType),
      );
      return { etag: res.headers["etag"] };
    }),
    delete: Effect.fn(`${ctx.tag}.delete`)(function* (key: string) {
      const base = yield* ctx.containerUrl;
      yield* send(
        ctx,
        HttpClientRequest.delete(`${base}/${encodeKey(key)}`),
        [404],
      );
    }),
  }) satisfies WriteBlobContainerClient;

/**
 * Build the impl Effect for a blob container capability: grant `role` on
 * the container to the host identity, register env vars, and return the
 * client from `makeClient`.
 */
export const makeBlobContainerHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.BlobContainerRead`. */
  tag: string;
  /** Built-in role GUID granted on the container. */
  role: string;
  makeClient: (ctx: BlobContainerHttpContext) => Client;
}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (container: BlobContainer) {
      const suffix = envSuffix(container.LogicalId);
      yield* bindAzureHost({
        tag: options.tag,
        resource: container,
        env: {
          [`AZURE_STORAGE_ACCOUNT_${suffix}`]: container.storageAccount,
          [`AZURE_STORAGE_CONTAINER_${suffix}`]: container.containerName,
        },
        roleAssignments: [
          { roleDefinitionId: options.role, scope: container.containerId },
        ],
      });
      const url =
        yield* Output.interpolate`https://${container.storageAccount}.blob.core.windows.net/${container.containerName}`;
      return options.makeClient({
        tag: `${options.tag}(${container.LogicalId})`,
        http,
        containerUrl: url,
      });
    });
  });
