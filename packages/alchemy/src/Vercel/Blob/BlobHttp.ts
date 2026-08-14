import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Functions/Function.ts";
import { FunctionEnvironment } from "../Functions/FunctionBridge.ts";
import type { BlobStore, BlobStoreAccess } from "./BlobStore.ts";
import {
  BLOB_TOKEN_ENV,
  BlobAlreadyExists,
  BlobBadRequest,
  BlobForbidden,
  BlobInternalError,
  BlobNotFound,
  BlobPreconditionFailed,
  BlobRateLimited,
  BlobUnauthorized,
  type BlobCommonError,
  type BlobListItem,
  type BlobObject,
  type GetBlobResult,
  type ListBlobsOptions,
  type ListBlobsResult,
  type PutBlobBody,
  type PutBlobOptions,
  type PutBlobResult,
} from "./BlobTypes.ts";

/**
 * INTERNAL scaffolding shared by the `ReadBlob`/`WriteBlob`/`ReadWriteBlob`
 * implementations — NOT exported from the Vercel `index.ts` (shared-
 * scaffolding convention). Raw typed ops over the Blob data plane
 * (`https://blob.vercel-storage.com`, live-verified wire protocol — see
 * processes/Vercel/PROBES.md) plus the shared binding builder.
 *
 * MANUAL-SPEC GAP: like the Queues data plane (`Queues/QueueApi.ts`), the
 * Blob data plane is absent from Vercel's management OpenAPI and needs a
 * non-management host + the store's RW token, so it is hand-typed here until
 * distilled grows per-service protocol overrides for OpenAPI providers.
 */

/** Default data-plane endpoint; `VERCEL_BLOB_API_URL` overrides (local emulation). */
export const DEFAULT_BLOB_API_URL = "https://blob.vercel-storage.com";

/** Env var that overrides the data-plane endpoint (probe-verified injectable). */
export const BLOB_API_URL_ENV = "VERCEL_BLOB_API_URL";

/** Wire version header sent with every data-plane request. */
const BLOB_API_VERSION = "12";

/** Everything a data-plane operation needs, resolved per call. */
export interface BlobScope {
  /** The store's RW token (`vercel_blob_rw_…`, platform-injected on connect). */
  readonly token: Redacted.Redacted<string>;
  /** Bare store id (no `store_` prefix), case-preserved. */
  readonly storeId: string;
  /** The store's access mode — sent as `x-vercel-blob-access` on writes. */
  readonly access: BlobStoreAccess;
  /** Data-plane endpoint for control operations. */
  readonly apiUrl: string;
}

/** Strip the management `store_` prefix off a store id. */
export const bareStoreId = (storeId: string): string =>
  storeId.startsWith("store_") ? storeId.slice("store_".length) : storeId;

/** Encode a pathname for use inside a URL, preserving `/` separators. */
const encodePathname = (pathname: string): string =>
  pathname.split("/").map(encodeURIComponent).join("/");

/**
 * The canonical content URL of a blob:
 * `https://{storeIdLower}.{access}.blob.vercel-storage.com/{pathname}`.
 */
export const blobUrlOf = (
  scope: Pick<BlobScope, "storeId" | "access">,
  pathname: string,
): string =>
  `https://${bareStoreId(scope.storeId).toLowerCase()}.${scope.access}.blob.vercel-storage.com/${encodePathname(pathname)}`;

const parseRetryAfterSeconds = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  return undefined;
};

/** Read the `{ error: { code, message } }` body shape (best-effort). */
const parseErrorBody = (body: string): { code?: string; message?: string } => {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string };
    };
    return parsed?.error ?? {};
  } catch {
    return {};
  }
};

/**
 * Map a non-2xx data-plane response to the typed Blob errors. `pathname`
 * scopes the not-found/CAS errors; operations without one (list, delete)
 * surface unexpected 404/412s as {@link BlobInternalError}.
 */
const failBlob = (input: {
  operation: string;
  pathname?: string | undefined;
  response: HttpClientResponse.HttpClientResponse;
}): Effect.Effect<
  never,
  BlobNotFound | BlobAlreadyExists | BlobPreconditionFailed | BlobCommonError
> =>
  Effect.gen(function* () {
    const { operation, pathname, response } = input;
    const body = yield* response.text;
    const { message: errMessage } = parseErrorBody(body);
    const message =
      errMessage ?? (body !== "" ? body : `HTTP ${response.status}`);
    switch (response.status) {
      case 400:
        if (pathname !== undefined && message.includes("already exists")) {
          return yield* new BlobAlreadyExists({ message, pathname });
        }
        return yield* new BlobBadRequest({ message, operation });
      case 401:
        return yield* new BlobUnauthorized({ message, operation });
      case 403:
        return yield* new BlobForbidden({ message, operation });
      case 404:
        if (pathname !== undefined) {
          return yield* new BlobNotFound({ message, pathname });
        }
        return yield* new BlobInternalError({
          message,
          operation,
          status: 404,
        });
      case 412:
        if (pathname !== undefined) {
          return yield* new BlobPreconditionFailed({ message, pathname });
        }
        return yield* new BlobInternalError({
          message,
          operation,
          status: 412,
        });
      case 429:
        return yield* new BlobRateLimited({
          message,
          operation,
          retryAfterSeconds: parseRetryAfterSeconds(
            response.headers["retry-after"],
          ),
        });
      default:
        return yield* new BlobInternalError({
          message,
          operation,
          status: response.status,
        });
    }
  });

const withAuth = (
  request: HttpClientRequest.HttpClientRequest,
  scope: BlobScope,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.setHeader(
    HttpClientRequest.bearerToken(request, scope.token),
    "x-api-version",
    BLOB_API_VERSION,
  );

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Collect a put body into bytes (Blob buffers through `arrayBuffer`). */
const toBodyBytes = (
  body: PutBlobBody,
): Effect.Effect<Uint8Array, BlobInternalError> =>
  typeof body === "string"
    ? Effect.sync(() => textEncoder.encode(body))
    : body instanceof Uint8Array
      ? Effect.succeed(body)
      : body instanceof ArrayBuffer
        ? Effect.sync(() => new Uint8Array(body))
        : Effect.tryPromise({
            try: async () => new Uint8Array(await body.arrayBuffer()),
            catch: (cause) =>
              new BlobInternalError({
                message: `Failed to read put body: ${String(cause)}`,
                operation: "put",
              }),
          });

// ─────────────────────────────────────────────────────────────────────────────
// Raw operations
// ─────────────────────────────────────────────────────────────────────────────

/** PUT {apiUrl}/?pathname={pathname} */
export const putBlobRaw = Effect.fn("Vercel.Blob.put")(function* (
  scope: BlobScope,
  pathname: string,
  body: PutBlobBody,
  options?: PutBlobOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const bytes = yield* toBodyBytes(body);
  let request = withAuth(
    HttpClientRequest.bodyUint8Array(
      HttpClientRequest.put(
        `${scope.apiUrl}/?pathname=${encodeURIComponent(pathname)}`,
      ),
      bytes,
      options?.contentType ?? "application/octet-stream",
    ),
    scope,
  );
  request = HttpClientRequest.setHeader(
    request,
    "x-vercel-blob-access",
    scope.access,
  );
  if (options?.ifMatch !== undefined) {
    request = HttpClientRequest.setHeader(
      request,
      "x-if-match",
      options.ifMatch,
    );
  }
  if (options?.allowOverwrite === false) {
    request = HttpClientRequest.setHeader(request, "x-allow-overwrite", "0");
  }
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* failBlob({ operation: "put", pathname, response });
  }
  const json = (yield* response.json) as {
    url: string;
    downloadUrl: string;
    pathname: string;
    contentType?: string;
    contentDisposition?: string;
    etag: string;
  };
  return {
    url: json.url,
    downloadUrl: json.downloadUrl,
    pathname: json.pathname,
    contentType: json.contentType,
    contentDisposition: json.contentDisposition,
    etag: json.etag,
  } satisfies PutBlobResult;
});

/** GET {apiUrl}/?url={blobUrl} — metadata only. */
export const headBlobRaw = Effect.fn("Vercel.Blob.head")(function* (
  scope: BlobScope,
  pathname: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = withAuth(
    HttpClientRequest.get(
      `${scope.apiUrl}/?url=${encodeURIComponent(blobUrlOf(scope, pathname))}`,
    ),
    scope,
  );
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* failBlob({ operation: "head", pathname, response });
  }
  const json = (yield* response.json) as {
    url: string;
    downloadUrl: string;
    pathname: string;
    contentType?: string;
    contentDisposition?: string;
    size: number;
    uploadedAt: string;
    cacheControl?: string;
    etag: string;
  };
  return {
    url: json.url,
    downloadUrl: json.downloadUrl,
    pathname: json.pathname,
    contentType: json.contentType,
    contentDisposition: json.contentDisposition,
    size: json.size,
    uploadedAt: new Date(json.uploadedAt),
    cacheControl: json.cacheControl,
    etag: json.etag,
  } satisfies BlobObject;
});

/** GET {apiUrl}/?prefix=&limit=&cursor= — one page of blobs. */
export const listBlobsRaw = Effect.fn("Vercel.Blob.list")(function* (
  scope: BlobScope,
  options?: ListBlobsOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const params = new URLSearchParams();
  if (options?.prefix !== undefined) params.set("prefix", options.prefix);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.cursor !== undefined) params.set("cursor", options.cursor);
  const query = params.toString();
  const request = withAuth(
    HttpClientRequest.get(`${scope.apiUrl}/${query === "" ? "" : `?${query}`}`),
    scope,
  );
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* failBlob({ operation: "list", response });
  }
  const json = (yield* response.json) as {
    hasMore: boolean;
    cursor?: string;
    blobs: Array<{
      url: string;
      downloadUrl: string;
      pathname: string;
      size: number;
      uploadedAt: string;
      etag: string;
    }>;
  };
  return {
    hasMore: json.hasMore,
    cursor: json.cursor,
    blobs: json.blobs.map(
      (blob): BlobListItem => ({
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: new Date(blob.uploadedAt),
        etag: blob.etag,
      }),
    ),
  } satisfies ListBlobsResult;
});

/** POST {apiUrl}/delete — idempotent batch delete by canonical URL. */
export const deleteBlobsRaw = Effect.fn("Vercel.Blob.del")(function* (
  scope: BlobScope,
  pathnames: readonly string[],
) {
  const client = yield* HttpClient.HttpClient;
  const urls = pathnames.map((pathname) =>
    pathname.startsWith("https://") ? pathname : blobUrlOf(scope, pathname),
  );
  const request = withAuth(
    HttpClientRequest.bodyText(
      HttpClientRequest.post(`${scope.apiUrl}/delete`),
      JSON.stringify({ urls }),
      "application/json",
    ),
    scope,
  );
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* failBlob({ operation: "del", response });
  }
  yield* response.text;
});

/** GET the blob's content from its canonical URL (bearer works for both access modes). */
export const getBlobRaw = Effect.fn("Vercel.Blob.get")(function* (
  scope: BlobScope,
  pathname: string,
) {
  const client = yield* HttpClient.HttpClient;
  const url = blobUrlOf(scope, pathname);
  // The bearer is required for private stores and harmless for public ones.
  const request = HttpClientRequest.bearerToken(
    HttpClientRequest.get(url),
    scope.token,
  );
  const response = yield* client.execute(request);
  if (response.status < 200 || response.status >= 300) {
    return yield* failBlob({ operation: "get", pathname, response });
  }
  const buffer = yield* response.arrayBuffer;
  const bytes = new Uint8Array(buffer);
  return {
    pathname,
    url,
    contentType: response.headers["content-type"],
    etag: response.headers["etag"],
    size: bytes.byteLength,
    bytes,
    text: Effect.sync(() => textDecoder.decode(bytes)),
    json: <T = unknown>() =>
      Effect.try({
        try: () => JSON.parse(textDecoder.decode(bytes)) as T,
        catch: (cause) =>
          new BlobInternalError({
            message: `Failed to parse blob ${pathname} as JSON: ${String(cause)}`,
            operation: "get",
          }),
      }),
  } satisfies GetBlobResult;
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared binding builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the shared deploy/runtime halves of a Blob capability:
 *
 * - **Deploy half** (guarded by `__ALCHEMY_RUNTIME__`): contributes the host
 *   Function's `projectId` onto the store's binding contract, so the store's
 *   reconciler connects the project — which is what makes the platform
 *   inject the `BLOB_READ_WRITE_TOKEN` env var the runtime half reads. The
 *   `storeId`/`access` accessors captured below flow through the host's env
 *   channel (the init-capture mechanism), creating the reverse dependency
 *   edge so the engine sequences store-connect BEFORE the Function's deploy
 *   (project env only takes effect on new deployments).
 * - **Runtime half**: resolves the {@link BlobScope} (token from the
 *   platform-injected env, store identity from the captured accessors) and
 *   hands it to `makeClient`.
 */
export const makeBlobHttpBinding = <Client>(options: {
  readonly makeClient: (scope: Effect.Effect<BlobScope>) => Client;
}) =>
  Effect.gen(function* () {
    // Instance-scoped: the FunctionEnvironment record is the live process
    // env at runtime (and `{}` during plan), so per-op key reads stay fresh.
    const env = yield* FunctionEnvironment;

    return Effect.fn(function* (store: BlobStore) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          // Connect the host's project to the store. The store's provider
          // owns the connection lifecycle (create/remove on unbind), so the
          // capability never calls the connections API itself.
          yield* store.bind`Blob(${store.LogicalId}, ${host.LogicalId})`({
            projects: [host.projectId],
          });
        }
      }
      // Init captures: registered on the host's env channel at deploy,
      // read back from the same env at runtime.
      const storeId = yield* store.storeId;
      const access = yield* store.access;

      const scope: Effect.Effect<BlobScope> = Effect.gen(function* () {
        const token = env[BLOB_TOKEN_ENV];
        if (token === undefined || token === "") {
          return yield* Effect.die(
            new Error(
              `Vercel.Blob: ${BLOB_TOKEN_ENV} is not set — the Function's project is not connected to the blob store (the binding registers the connection at deploy; a deployment created before the connection cannot see the token)`,
            ),
          );
        }
        return {
          token: Redacted.make(token),
          storeId: yield* storeId,
          access: (yield* access) as BlobStoreAccess,
          apiUrl: env[BLOB_API_URL_ENV] ?? DEFAULT_BLOB_API_URL,
        } satisfies BlobScope;
      });

      return options.makeClient(scope);
    });
  });
