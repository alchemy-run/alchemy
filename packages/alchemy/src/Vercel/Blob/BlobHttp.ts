import * as blobData from "@distilled.cloud/vercel/blob_data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
 * scaffolding convention). Thin wrappers over the distilled Blob data-plane
 * service (`@distilled.cloud/vercel/blob_data` — generated from the
 * hand-authored manual spec, live-verified wire protocol) that adapt the
 * generated request/response/error shapes onto the public types in
 * `BlobTypes.ts`, plus the shared binding builder.
 */

/** Default data-plane endpoint; `VERCEL_BLOB_API_URL` overrides (local emulation). */
export const DEFAULT_BLOB_API_URL = "https://blob.vercel-storage.com";

/**
 * Env var that overrides the data-plane endpoint (probe-verified
 * injectable). The generated distilled operations read it per request, so
 * injecting it into a Function's env (dev-mode emulation) reroutes every
 * data-plane call.
 */
export const BLOB_API_URL_ENV = "VERCEL_BLOB_API_URL";

/** Everything a data-plane operation needs, resolved per call. */
export interface BlobScope {
  /** The store's RW token (`vercel_blob_rw_…`, platform-injected on connect). */
  readonly token: Redacted.Redacted<string>;
  /** Bare store id (no `store_` prefix), case-preserved. */
  readonly storeId: string;
  /** The store's access mode — sent as `x-vercel-blob-access` on writes. */
  readonly access: BlobStoreAccess;
  /**
   * Data-plane endpoint for control operations — used only to derive
   * {@link contentUrlOf}'s URL shape; the distilled operations resolve
   * their actual endpoint from `VERCEL_BLOB_API_URL` per request.
   */
  readonly apiUrl: string;
}

/**
 * Strip the management `store_` prefix (and the local provider's `dev:`
 * marker) off a store id, leaving the bare host-label id.
 */
export const bareStoreId = (storeId: string): string => {
  const withoutMode = storeId.startsWith("dev:")
    ? storeId.slice("dev:".length)
    : storeId;
  return withoutMode.startsWith("store_")
    ? withoutMode.slice("store_".length)
    : withoutMode;
};

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

/**
 * The URL blob CONTENT is fetched from. On the live platform this is the
 * canonical `…blob.vercel-storage.com` URL; with a data-plane override
 * (`VERCEL_BLOB_API_URL`, dev-mode emulation) content is served by the
 * override host under `/{storeIdLower}.{access}/{pathname}`.
 */
export const contentUrlOf = (scope: BlobScope, pathname: string): string =>
  scope.apiUrl === DEFAULT_BLOB_API_URL
    ? blobUrlOf(scope, pathname)
    : `${scope.apiUrl}/${bareStoreId(scope.storeId).toLowerCase()}.${scope.access}/${encodePathname(pathname)}`;

/** The content-host handle filling distilled's `{store}` endpoint label. */
const storeHostLabel = (scope: Pick<BlobScope, "storeId" | "access">): string =>
  `${bareStoreId(scope.storeId).toLowerCase()}.${scope.access}`;

const textDecoder = new TextDecoder();

/** The full error union any distilled Blob data-plane operation can fail with. */
type DistilledBlobError =
  | blobData.BlobAlreadyExists
  | blobData.BlobPreconditionFailed
  | blobData.BlobNotFound
  | blobData.BlobBadRequest
  | blobData.BlobUnauthorized
  | blobData.BlobForbidden
  | blobData.VercelDataOpError;

/**
 * Map a distilled data-plane error onto the public `Vercel.Blob.*` taxonomy
 * (`BlobTypes.ts`). `pathname` scopes the not-found/CAS/conditional-create
 * errors; operations without one (list, delete) surface those statuses as
 * {@link BlobInternalError}, mirroring the pre-distilled behavior.
 */
const toBlobError = (
  operation: string,
  pathname: string | undefined,
  error: DistilledBlobError,
):
  | BlobNotFound
  | BlobAlreadyExists
  | BlobPreconditionFailed
  | BlobCommonError => {
  switch (error._tag) {
    case "BlobAlreadyExists":
      return pathname !== undefined
        ? new BlobAlreadyExists({ message: error.message, pathname })
        : new BlobBadRequest({ message: error.message, operation });
    case "BlobPreconditionFailed":
      return pathname !== undefined
        ? new BlobPreconditionFailed({ message: error.message, pathname })
        : new BlobInternalError({
            message: error.message,
            operation,
            status: 412,
          });
    case "BlobNotFound":
      return pathname !== undefined
        ? new BlobNotFound({ message: error.message, pathname })
        : new BlobInternalError({
            message: error.message,
            operation,
            status: 404,
          });
    case "BlobBadRequest":
      return new BlobBadRequest({ message: error.message, operation });
    case "BlobUnauthorized":
    case "Unauthorized":
      return new BlobUnauthorized({ message: error.message, operation });
    case "BlobForbidden":
      return new BlobForbidden({ message: error.message, operation });
    case "TooManyRequests":
      return new BlobRateLimited({
        message: error.message,
        operation,
        retryAfterSeconds:
          error.retryAfter !== undefined
            ? Duration.toSeconds(error.retryAfter)
            : undefined,
      });
    case "InternalServerError":
      return new BlobInternalError({
        message: error.message,
        operation,
        status: 500,
      });
    case "BadGateway":
      return new BlobInternalError({
        message: error.message,
        operation,
        status: 502,
      });
    case "ServiceUnavailable":
      return new BlobInternalError({
        message: error.message,
        operation,
        status: 503,
      });
    case "GatewayTimeout":
      return new BlobInternalError({
        message: error.message,
        operation,
        status: 504,
      });
    case "PaymentRequired":
      return new BlobInternalError({
        message: error.message,
        operation,
        status: 402,
      });
    case "Gone":
      return new BlobInternalError({
        message: error.message,
        operation,
        status: 410,
      });
    case "UnknownVercelError":
      return new BlobInternalError({
        message: error.message ?? "unknown data-plane failure",
        operation,
      });
    case "VercelParseError":
      return new BlobInternalError({
        message: `Failed to decode the data-plane response: ${String(error.cause)}`,
        operation,
      });
    default:
      // HttpClientError — already a member of BlobCommonError.
      return error;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Raw operations (distilled-backed)
// ─────────────────────────────────────────────────────────────────────────────

/** PUT {apiUrl}/?pathname={pathname} */
export const putBlobRaw = Effect.fn("Vercel.Blob.put")(function* (
  scope: BlobScope,
  pathname: string,
  body: PutBlobBody,
  options?: PutBlobOptions,
) {
  const response = yield* blobData
    .putBlob({
      token: scope.token,
      pathname,
      access: scope.access,
      contentType: options?.contentType ?? "application/octet-stream",
      ifMatch: options?.ifMatch,
      // The data plane's WIRE default (header absent) is to REFUSE
      // overwrites (400 "This blob already exists…") — live-verified. Send
      // the header explicitly on every put so the client's documented
      // default (`allowOverwrite: true`) actually overwrites; `false` opts
      // into the typed conditional-create failure.
      allowOverwrite: options?.allowOverwrite === false ? "0" : "1",
      body,
    })
    .pipe(Effect.mapError((error) => toBlobError("put", pathname, error)));
  return {
    url: response.url,
    downloadUrl: response.downloadUrl,
    pathname: response.pathname,
    contentType: response.contentType,
    contentDisposition: response.contentDisposition,
    etag: response.etag,
  } satisfies PutBlobResult;
});

/** GET {apiUrl}/?url={blobUrl} — metadata only. */
export const headBlobRaw = Effect.fn("Vercel.Blob.head")(function* (
  scope: BlobScope,
  pathname: string,
) {
  const response = yield* blobData
    .headBlob({ token: scope.token, url: blobUrlOf(scope, pathname) })
    .pipe(Effect.mapError((error) => toBlobError("head", pathname, error)));
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
});

/** GET {apiUrl}/?prefix=&limit=&cursor= — one page of blobs. */
export const listBlobsRaw = Effect.fn("Vercel.Blob.list")(function* (
  scope: BlobScope,
  options?: ListBlobsOptions,
) {
  const response = yield* blobData
    .listBlobs({
      token: scope.token,
      prefix: options?.prefix,
      limit: options?.limit,
      cursor: options?.cursor,
    })
    .pipe(Effect.mapError((error) => toBlobError("list", undefined, error)));
  return {
    hasMore: response.hasMore,
    cursor: response.cursor,
    blobs: response.blobs.map(
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
  const urls = pathnames.map((pathname) =>
    // Accept full content URLs (canonical https, or the local emulator's
    // http form) as well as bare pathnames.
    /^https?:\/\//.test(pathname) ? pathname : blobUrlOf(scope, pathname),
  );
  yield* blobData
    .deleteBlobs({ token: scope.token, urls })
    .pipe(Effect.mapError((error) => toBlobError("del", undefined, error)));
});

/** GET the blob's content from its per-store host (bearer works for both access modes). */
export const getBlobRaw = Effect.fn("Vercel.Blob.get")(function* (
  scope: BlobScope,
  pathname: string,
) {
  const url = contentUrlOf(scope, pathname);
  const response = yield* blobData
    .getBlobContent({
      store: storeHostLabel(scope),
      token: scope.token,
      pathname,
    })
    .pipe(Effect.mapError((error) => toBlobError("get", pathname, error)));
  const bytes = response.body;
  return {
    pathname,
    url,
    contentType: response.contentType,
    etag: response.etag,
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
          // Dev-mode env injection: the LOCAL store provider publishes its
          // emulator endpoint + deterministic token as attributes; both are
          // `undefined` on the live platform (undefined env values are
          // skipped by env sync — the InvokeFunction `protectionBypass`
          // precedent), where the platform injects `BLOB_READ_WRITE_TOKEN`
          // through the store↔project connection instead. Injecting real
          // env vars (not just captures) keeps `@vercel/blob` and the
          // async `readWriteBlobFromEnv` client working locally too.
          yield* host.bind`BlobEnv(${store.LogicalId}, ${host.LogicalId})`({
            env: {
              [BLOB_API_URL_ENV]: store.localApiUrl,
              [BLOB_TOKEN_ENV]: store.localToken,
            },
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
