/**
 * Promise-based Blob client for **plain async Functions** (no Effect
 * runtime exposed to the caller). Rides the same distilled Blob data-plane
 * operations (`@distilled.cloud/vercel/blob_data`) as the Effect bindings —
 * one live-verified wire protocol for every client — run one-shot on a
 * fetch-backed HttpClient with failures surfaced as plain `Error`s.
 * For Effect code use the `ReadBlob`/`WriteBlob`/`ReadWriteBlob` bindings.
 */
import * as blobData from "@distilled.cloud/vercel/blob_data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  BLOB_API_URL_ENV,
  bareStoreId,
  blobUrlOf,
  contentUrlOf,
  DEFAULT_BLOB_API_URL,
  type BlobScope,
} from "./BlobHttp.ts";
import {
  BLOB_TOKEN_ENV,
  type BlobObject,
  type ListBlobsOptions,
  type ListBlobsResult,
  type PutBlobBody,
  type PutBlobOptions,
  type PutBlobResult,
} from "./BlobTypes.ts";

export interface BlobFromEnvOptions {
  /**
   * The store's RW token. Defaults to the `BLOB_READ_WRITE_TOKEN` env var
   * the platform injects into every connected project.
   */
  readonly token?: string;
  /**
   * The store's access mode — determines the canonical content URL host and
   * the `x-vercel-blob-access` header on writes.
   * @default "public"
   */
  readonly access?: "public" | "private";
  /**
   * Explicit data-plane endpoint override for THIS client (out-of-band use,
   * e.g. a test process pointing at the local emulator). Inside a Function
   * you never need it: the distilled operations read the
   * `VERCEL_BLOB_API_URL` env var per request, which dev-mode emulation
   * injects automatically.
   */
  readonly apiUrl?: string;
}

/** Result of an async `get`. */
export interface AsyncGetBlobResult {
  readonly pathname: string;
  readonly url: string;
  readonly contentType?: string | undefined;
  readonly etag?: string | undefined;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly text: string;
}

/** Promise-based read/write Blob client for plain async Functions. */
export interface AsyncReadWriteBlobClient {
  put(
    pathname: string,
    body: PutBlobBody,
    options?: PutBlobOptions,
  ): Promise<PutBlobResult>;
  head(pathname: string): Promise<BlobObject>;
  get(pathname: string): Promise<AsyncGetBlobResult>;
  list(options?: ListBlobsOptions): Promise<ListBlobsResult>;
  del(pathnames: string | readonly string[]): Promise<void>;
}

const resolveToken = (options?: BlobFromEnvOptions): string => {
  const token = options?.token ?? process.env[BLOB_TOKEN_ENV];
  if (token === undefined || token === "") {
    throw new Error(
      `Vercel.readWriteBlobFromEnv: no ${BLOB_TOKEN_ENV} in the environment — is the Function's project connected to the blob store?`,
    );
  }
  return token;
};

/** Derive the bare store id from the token (`vercel_blob_rw_{storeId}_…`). */
const storeIdOfToken = (token: string): string => {
  const part = token.split("_")[3];
  if (part === undefined || part === "") {
    throw new Error(
      "Vercel.readWriteBlobFromEnv: cannot derive the store id from the token (expected a vercel_blob_rw_… token)",
    );
  }
  return part;
};

/** The full error union across the distilled Blob data-plane operations. */
type BlobDataError =
  | blobData.PutBlobError
  | blobData.HeadBlobError
  | blobData.GetBlobContentError
  | blobData.ListBlobsError
  | blobData.DeleteBlobsError;

/** HTTP status behind each typed data-plane error tag (for error messages). */
const ERROR_STATUS: Record<string, number> = {
  BlobAlreadyExists: 400,
  BlobBadRequest: 400,
  BlobUnauthorized: 401,
  BlobForbidden: 403,
  BlobNotFound: 404,
  BlobPreconditionFailed: 412,
  Unauthorized: 401,
  PaymentRequired: 402,
  Gone: 410,
  TooManyRequests: 429,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
};

const statusOf = (error: BlobDataError): number | undefined =>
  error._tag === "HttpClientError"
    ? error.response?.status
    : ERROR_STATUS[error._tag];

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const PER_STORE_HOST_SUFFIX = ".blob.vercel-storage.com";

/**
 * Re-home a data-plane request onto an explicit `apiUrl` override (used
 * out-of-band, where injecting `VERCEL_BLOB_API_URL` process-wide would
 * race concurrent live-endpoint calls). Mirrors the distilled protocol's
 * own override mapping: control ops move to `{override}`, per-store content
 * reads to `{override}/{store}`.
 */
const rehomeRequest =
  (override: string) =>
  (
    request: HttpClientRequest.HttpClientRequest,
  ): HttpClientRequest.HttpClientRequest => {
    const base = stripTrailingSlash(override);
    // Already re-homed by a VERCEL_BLOB_API_URL env override — swap prefixes.
    const envOverride = process.env[BLOB_API_URL_ENV];
    if (envOverride !== undefined && envOverride !== "") {
      const envBase = stripTrailingSlash(envOverride);
      return request.url.startsWith(envBase)
        ? HttpClientRequest.setUrl(
            request,
            `${base}${request.url.slice(envBase.length)}`,
          )
        : request;
    }
    const url = new URL(request.url);
    // Control operations ride the default endpoint.
    if (url.origin === DEFAULT_BLOB_API_URL) {
      return HttpClientRequest.setUrl(
        request,
        `${base}${url.pathname}${url.search}`,
      );
    }
    // Content reads ride the per-store host — move to the override's path form.
    if (url.hostname.endsWith(PER_STORE_HOST_SUFFIX)) {
      const store = url.hostname.slice(0, -PER_STORE_HOST_SUFFIX.length);
      return HttpClientRequest.setUrl(
        request,
        `${base}/${store}${url.pathname}${url.search}`,
      );
    }
    return request;
  };

/**
 * Build a promise-based Blob client for a plain async Function from the
 * ambient environment: the platform-injected `BLOB_READ_WRITE_TOKEN` of the
 * connected store, plus the store's access mode (needed to address blob
 * content; pass `access: "private"` for private stores).
 *
 * @example Async handler
 * ```typescript
 * import { readWriteBlobFromEnv } from "alchemy/Vercel";
 * const uploads = readWriteBlobFromEnv({ access: "private" });
 *
 * export default {
 *   async fetch(request: Request): Promise<Response> {
 *     const put = await uploads.put("hello.txt", "hi", { contentType: "text/plain" });
 *     const blob = await uploads.get("hello.txt");
 *     return Response.json({ etag: put.etag, text: blob.text });
 *   },
 * };
 * ```
 */
export const readWriteBlobFromEnv = (
  options?: BlobFromEnvOptions,
): AsyncReadWriteBlobClient => {
  const access = options?.access ?? "public";
  const apiUrlOverride = options?.apiUrl;
  const scopeOf = (token: string): BlobScope => ({
    token: Redacted.make(token),
    storeId: storeIdOfToken(token),
    access,
    apiUrl:
      apiUrlOverride ?? process.env[BLOB_API_URL_ENV] ?? DEFAULT_BLOB_API_URL,
  });
  // Same distilled data-plane ops as the Effect clients — endpoint
  // resolution (`VERCEL_BLOB_API_URL`), `x-api-version`, and the typed
  // error matchers all live there. Run one-shot on a fetch-backed client;
  // failures become plain Errors.
  const run = async <A>(
    operation: string,
    effect: Effect.Effect<A, BlobDataError, HttpClient.HttpClient>,
  ): Promise<A> => {
    const rehomed =
      apiUrlOverride === undefined
        ? effect
        : effect.pipe(
            Effect.updateService(HttpClient.HttpClient, (client) =>
              HttpClient.mapRequest(client, rehomeRequest(apiUrlOverride)),
            ),
          );
    const result = await Effect.runPromise(
      Effect.result(rehomed).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    if (Result.isFailure(result)) {
      const cause = result.failure;
      const status = statusOf(cause);
      const message =
        "message" in cause && cause.message !== undefined
          ? String(cause.message)
          : cause._tag;
      throw new Error(
        `Vercel.readWriteBlobFromEnv: ${operation} failed with ${status ?? cause._tag}: ${message}`,
        { cause },
      );
    }
    return result.success;
  };

  return {
    async put(pathname, body, putOptions) {
      const scope = scopeOf(resolveToken(options));
      const response = await run(
        "put",
        blobData.putBlob({
          token: scope.token,
          pathname,
          access,
          contentType: putOptions?.contentType ?? "application/octet-stream",
          ifMatch: putOptions?.ifMatch,
          // The data plane's WIRE default (header absent) is to REFUSE
          // overwrites — send the header explicitly so the documented
          // client default (`allowOverwrite: true`) actually overwrites,
          // matching the Effect client (`putBlobRaw`).
          allowOverwrite: putOptions?.allowOverwrite === false ? "0" : "1",
          body,
        }),
      );
      return {
        url: response.url,
        downloadUrl: response.downloadUrl,
        pathname: response.pathname,
        contentType: response.contentType,
        contentDisposition: response.contentDisposition,
        etag: response.etag,
      } satisfies PutBlobResult;
    },
    async head(pathname) {
      const scope = scopeOf(resolveToken(options));
      const response = await run(
        "head",
        blobData.headBlob({
          token: scope.token,
          url: blobUrlOf(scope, pathname),
        }),
      );
      return {
        url: response.url,
        downloadUrl: response.downloadUrl,
        pathname: response.pathname,
        contentType: response.contentType,
        contentDisposition: response.contentDisposition,
        size: response.size,
        uploadedAt: new Date(response.uploadedAt),
        cacheControl: response.cacheControl,
        etag: response.etag,
      } satisfies BlobObject;
    },
    async get(pathname) {
      const scope = scopeOf(resolveToken(options));
      const response = await run(
        "get",
        blobData.getBlobContent({
          store: `${bareStoreId(scope.storeId).toLowerCase()}.${access}`,
          token: scope.token,
          pathname,
        }),
      );
      const bytes = response.body;
      return {
        pathname,
        url: contentUrlOf(scope, pathname),
        contentType: response.contentType,
        etag: response.etag,
        size: bytes.byteLength,
        bytes,
        text: new TextDecoder().decode(bytes),
      };
    },
    async list(listOptions) {
      const scope = scopeOf(resolveToken(options));
      const response = await run(
        "list",
        blobData.listBlobs({
          token: scope.token,
          prefix: listOptions?.prefix,
          limit: listOptions?.limit,
          cursor: listOptions?.cursor,
        }),
      );
      return {
        hasMore: response.hasMore,
        cursor: response.cursor,
        blobs: response.blobs.map((blob) => ({
          url: blob.url,
          downloadUrl: blob.downloadUrl,
          pathname: blob.pathname,
          size: blob.size,
          uploadedAt: new Date(blob.uploadedAt),
          etag: blob.etag,
        })),
      } satisfies ListBlobsResult;
    },
    async del(pathnames) {
      const scope = scopeOf(resolveToken(options));
      const list = typeof pathnames === "string" ? [pathnames] : pathnames;
      const urls = list.map((pathname) =>
        // Accept full content URLs (canonical https, or the local
        // emulator's http form) as well as bare pathnames.
        /^https?:\/\//.test(pathname) ? pathname : blobUrlOf(scope, pathname),
      );
      await run("del", blobData.deleteBlobs({ token: scope.token, urls }));
    },
  };
};
