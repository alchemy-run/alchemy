/**
 * INTERNAL — the dev-mode (`alchemy dev`) Vercel Blob data-plane emulator.
 * NOT exported from the Vercel `index.ts` (shared-scaffolding convention).
 *
 * One HTTP server per sidecar serves EVERY local blob store, speaking the
 * live-verified wire protocol subset our clients (and `@vercel/blob`) use
 * (see processes/Vercel/PROBES.md, "Blob capability probes"):
 *
 * - `PUT /?pathname=…` — write (`x-if-match` CAS → 412 `precondition_failed`;
 *   wire default REFUSES overwrites, `x-allow-overwrite: 1` opts in; the
 *   `x-vercel-blob-access` header must match the store's access mode)
 * - `GET /?url=…` — head metadata (404 `not_found`)
 * - `GET /?prefix=&limit=&cursor=` — list page
 * - `POST /delete` `{urls}` — idempotent batch delete
 * - `GET /{store}.{access}/{pathname}` — blob content (`?download=1` forces
 *   attachment disposition; private stores require the store's bearer token)
 *
 * Clients are pointed here through the probe-verified `VERCEL_BLOB_API_URL`
 * override, injected into the local Function's env by the Blob capability
 * bindings (see `makeBlobHttpBinding`). Etags are quoted sha256 content
 * hashes, so CAS semantics match the platform's.
 *
 * The data plane is directory-backed under
 * `.alchemy/local/blob/{storeId}/` — content lives in `objects/{sha256}`,
 * metadata in `index.json` — so blobs survive dev-session restarts.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { httpServer } from "../../Util/PlatformServices.ts";
import { sha256 } from "../../Util/sha256.ts";
import { bareStoreId } from "./BlobHttp.ts";
import type { BlobStoreAccess } from "./BlobStore.ts";

/** A registered local store (one per `dev:store_…` resource row). */
export interface LocalBlobStoreHandle {
  /** The resource's storeId (`dev:store_{name}`). */
  readonly storeId: string;
  /** Lowercased bare id — the host/path label clients derive from the storeId. */
  readonly slug: string;
  /** Access mode (private content reads require the bearer token). */
  readonly access: BlobStoreAccess;
  /**
   * The store's deterministic local RW token
   * (`vercel_blob_rw_{slug}_{secret}`) — same shape as the platform's, so
   * `storeIdOfToken`-style derivation in the async client keeps working.
   */
  readonly token: string;
}

export interface LocalBlobServer {
  /** Local data-plane origin, e.g. `http://localhost:53211` (no trailing slash). */
  readonly url: string;
  /** Register (or re-open, hydrating from disk) a store. Idempotent. */
  readonly openStore: (input: {
    readonly storeId: string;
    readonly access: BlobStoreAccess;
  }) => Effect.Effect<LocalBlobStoreHandle>;
  /** Deregister a store and remove its directory. Idempotent. */
  readonly dropStore: (storeId: string) => Effect.Effect<void>;
  /** Whether the store is currently registered. */
  readonly hasStore: (storeId: string) => Effect.Effect<boolean>;
}

/** One blob's metadata row (the persisted `index.json` shape). */
interface BlobRow {
  readonly pathname: string;
  readonly size: number;
  /** epoch millis */
  readonly uploadedAt: number;
  /** Quoted sha256 content hash. */
  readonly etag: string;
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly cacheControl: string;
  /** Content address — `objects/{sha256}` (unquoted hash). */
  readonly object: string;
}

interface StoreEntry {
  readonly handle: LocalBlobStoreHandle;
  readonly directory: string;
  readonly blobs: Map<string, BlobRow>;
  /** Serializes mutations so CAS / conditional creates are atomic. */
  readonly lock: Semaphore.Semaphore;
}

const INDEX_FILE = "index.json";
const OBJECTS_DIR = "objects";
const DEFAULT_LIST_LIMIT = 1000;
const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** The host/path label a storeId maps to (matches `blobUrlOf`'s host). */
export const localStoreSlug = (storeId: string): string =>
  bareStoreId(storeId).toLowerCase();

const encodePathname = (pathname: string): string =>
  pathname.split("/").map(encodeURIComponent).join("/");

const unquoteEtag = (etag: string): string =>
  etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;

const errorJson = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });

/**
 * Parse a blob content URL — either the platform-canonical
 * `https://{slug}.{access}.blob.vercel-storage.com/{pathname}` or this
 * emulator's local form `http://…/{slug}.{access}/{pathname}`.
 */
const parseBlobUrl = (
  raw: string,
): { slug: string; access: string; pathname: string } | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const decodedPath = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (url.hostname.endsWith(".blob.vercel-storage.com")) {
    const [slug, access] = url.hostname.split(".");
    if (slug === undefined || access === undefined) return undefined;
    return { slug, access, pathname: decodedPath };
  }
  const match = /^([^/]+)\.(public|private)\/(.*)$/.exec(decodedPath);
  if (match === null) return undefined;
  return { slug: match[1], access: match[2], pathname: match[3] };
};

/**
 * Serve the local Blob data plane in the ambient `Scope` (one server per
 * sidecar; stores register/deregister through the returned handle as their
 * resource rows reconcile and delete).
 */
export const makeLocalBlobServer = Effect.fn("Vercel.LocalBlobServer")(
  function* (options: { readonly baseDirectory: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /** keyed by slug — the label every wire shape addresses stores by. */
    const stores = new Map<string, StoreEntry>();
    const bySlug = (slug: string) => stores.get(slug);
    const byStoreId = (storeId: string) => bySlug(localStoreSlug(storeId));

    const storeDirectory = (storeId: string) =>
      path.join(options.baseDirectory, encodeURIComponent(storeId));

    const persistIndex = (entry: StoreEntry) =>
      fs.writeFileString(
        path.join(entry.directory, INDEX_FILE),
        JSON.stringify(
          {
            version: 1,
            storeId: entry.handle.storeId,
            access: entry.handle.access,
            blobs: [...entry.blobs.values()],
          },
          null,
          2,
        ),
      );

    /** Remove a content object unless another row still references it. */
    const gcObject = (entry: StoreEntry, object: string) =>
      Effect.suspend(() => {
        for (const row of entry.blobs.values()) {
          if (row.object === object) return Effect.void;
        }
        return fs
          .remove(path.join(entry.directory, OBJECTS_DIR, object))
          .pipe(Effect.ignore);
      });

    const contentUrl = (entry: StoreEntry, pathname: string) =>
      `${serverUrl}/${entry.handle.slug}.${entry.handle.access}/${encodePathname(pathname)}`;

    const rowJson = (entry: StoreEntry, row: BlobRow) => ({
      url: contentUrl(entry, row.pathname),
      downloadUrl: `${contentUrl(entry, row.pathname)}?download=1`,
      pathname: row.pathname,
      size: row.size,
      uploadedAt: new Date(row.uploadedAt).toISOString(),
      etag: row.etag,
    });

    /** Resolve the bearer token to its registered store. */
    const authenticate = (
      request: HttpServerRequest.HttpServerRequest,
    ): StoreEntry | undefined => {
      const header = request.headers.authorization;
      if (header === undefined || !header.startsWith("Bearer ")) {
        return undefined;
      }
      const token = header.slice("Bearer ".length);
      const match = /^vercel_blob_rw_([^_]+)_/.exec(token);
      if (match === null) return undefined;
      const entry = bySlug(match[1].toLowerCase());
      if (entry === undefined || entry.handle.token !== token) {
        return undefined;
      }
      return entry;
    };

    const handlePut = Effect.fn(function* (
      request: HttpServerRequest.HttpServerRequest,
      url: URL,
    ) {
      const entry = authenticate(request);
      if (entry === undefined) {
        return errorJson(401, "unauthorized", "Access denied (invalid token)");
      }
      const pathname = url.searchParams.get("pathname") ?? "";
      if (pathname === "") {
        return errorJson(400, "bad_request", "pathname is required");
      }
      const accessHeader = request.headers["x-vercel-blob-access"];
      if (
        entry.handle.access === "private"
          ? accessHeader !== "private"
          : accessHeader === "private"
      ) {
        return errorJson(
          400,
          "bad_request",
          entry.handle.access === "private"
            ? "Cannot use public access on a private store"
            : "Cannot use private access on a public store",
        );
      }
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      return yield* Semaphore.withPermits(
        entry.lock,
        1,
      )(
        Effect.gen(function* () {
          const existing = entry.blobs.get(pathname);
          const ifMatch = request.headers["x-if-match"];
          if (ifMatch !== undefined) {
            if (
              existing === undefined ||
              unquoteEtag(existing.etag) !== unquoteEtag(ifMatch)
            ) {
              return errorJson(
                412,
                "precondition_failed",
                "The blob's etag does not match the provided x-if-match value",
              );
            }
          } else if (
            existing !== undefined &&
            request.headers["x-allow-overwrite"] !== "1"
          ) {
            // The live wire default (header absent or `0`) REFUSES
            // overwrites — probe-verified.
            return errorJson(
              400,
              "bad_request",
              "This blob already exists. Use `allowOverwrite: true` if you want to overwrite it.",
            );
          }
          const object = yield* sha256(bytes);
          yield* fs.makeDirectory(path.join(entry.directory, OBJECTS_DIR), {
            recursive: true,
          });
          yield* fs.writeFile(
            path.join(entry.directory, OBJECTS_DIR, object),
            bytes,
          );
          const basename = pathname.split("/").at(-1) ?? pathname;
          const row: BlobRow = {
            pathname,
            size: bytes.byteLength,
            uploadedAt: Date.now(),
            etag: `"${object}"`,
            contentType:
              request.headers["content-type"] ?? "application/octet-stream",
            contentDisposition: `inline; filename="${basename}"`,
            cacheControl: DEFAULT_CACHE_CONTROL,
            object,
          };
          entry.blobs.set(pathname, row);
          if (existing !== undefined && existing.object !== object) {
            yield* gcObject(entry, existing.object);
          }
          yield* persistIndex(entry);
          return HttpServerResponse.jsonUnsafe({
            url: contentUrl(entry, pathname),
            downloadUrl: `${contentUrl(entry, pathname)}?download=1`,
            pathname,
            contentType: row.contentType,
            contentDisposition: row.contentDisposition,
            etag: row.etag,
          });
        }),
      );
    });

    const handleHead = (
      request: HttpServerRequest.HttpServerRequest,
      url: URL,
    ) =>
      Effect.sync(() => {
        const entry = authenticate(request);
        if (entry === undefined) {
          return errorJson(
            401,
            "unauthorized",
            "Access denied (invalid token)",
          );
        }
        const target = parseBlobUrl(url.searchParams.get("url") ?? "");
        const row =
          target !== undefined && target.slug === entry.handle.slug
            ? entry.blobs.get(target.pathname)
            : undefined;
        if (row === undefined) {
          return errorJson(
            404,
            "not_found",
            "The requested blob does not exist",
          );
        }
        return HttpServerResponse.jsonUnsafe({
          ...rowJson(entry, row),
          contentType: row.contentType,
          contentDisposition: row.contentDisposition,
          cacheControl: row.cacheControl,
        });
      });

    const handleList = (
      request: HttpServerRequest.HttpServerRequest,
      url: URL,
    ) =>
      Effect.sync(() => {
        const entry = authenticate(request);
        if (entry === undefined) {
          return errorJson(
            401,
            "unauthorized",
            "Access denied (invalid token)",
          );
        }
        const prefix = url.searchParams.get("prefix") ?? "";
        const cursor = url.searchParams.get("cursor");
        const limitParam = Number(url.searchParams.get("limit") ?? "");
        const limit =
          Number.isFinite(limitParam) && limitParam > 0
            ? limitParam
            : DEFAULT_LIST_LIMIT;
        const rows = [...entry.blobs.values()]
          .filter((row) => row.pathname.startsWith(prefix))
          .filter((row) => cursor === null || row.pathname > cursor)
          .sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
        const page = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return HttpServerResponse.jsonUnsafe({
          hasMore,
          ...(hasMore ? { cursor: page.at(-1)?.pathname } : {}),
          blobs: page.map((row) => rowJson(entry, row)),
        });
      });

    const handleDelete = Effect.fn(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const entry = authenticate(request);
      if (entry === undefined) {
        return errorJson(401, "unauthorized", "Access denied (invalid token)");
      }
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )) as { urls?: unknown } | undefined;
      const urls = Array.isArray(body?.urls) ? body.urls : [];
      return yield* Semaphore.withPermits(
        entry.lock,
        1,
      )(
        Effect.gen(function* () {
          let mutated = false;
          for (const raw of urls) {
            if (typeof raw !== "string") continue;
            const target = parseBlobUrl(raw);
            if (target === undefined || target.slug !== entry.handle.slug) {
              continue;
            }
            const row = entry.blobs.get(target.pathname);
            if (row === undefined) continue; // idempotent
            entry.blobs.delete(target.pathname);
            yield* gcObject(entry, row.object);
            mutated = true;
          }
          if (mutated) yield* persistIndex(entry);
          return HttpServerResponse.jsonUnsafe(null);
        }),
      );
    });

    const handleContent = Effect.fn(function* (
      request: HttpServerRequest.HttpServerRequest,
      url: URL,
    ) {
      const target = parseBlobUrl(`${serverUrl}${url.pathname}`);
      const entry = target === undefined ? undefined : bySlug(target.slug);
      if (
        target === undefined ||
        entry === undefined ||
        target.access !== entry.handle.access
      ) {
        return errorJson(404, "not_found", "The requested blob does not exist");
      }
      if (
        entry.handle.access === "private" &&
        authenticate(request) !== entry
      ) {
        return errorJson(
          403,
          "forbidden",
          "Private blobs require an authenticated request",
        );
      }
      const row = entry.blobs.get(target.pathname);
      if (row === undefined) {
        return errorJson(404, "not_found", "The requested blob does not exist");
      }
      const bytes = yield* fs
        .readFile(path.join(entry.directory, OBJECTS_DIR, row.object))
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (bytes === undefined) {
        return errorJson(404, "not_found", "The requested blob does not exist");
      }
      const download = url.searchParams.get("download") === "1";
      return HttpServerResponse.uint8Array(bytes, {
        contentType: row.contentType,
      }).pipe(
        HttpServerResponse.setHeaders({
          etag: row.etag,
          "cache-control": row.cacheControl,
          "content-disposition": download
            ? `attachment; filename="${target.pathname.split("/").at(-1) ?? target.pathname}"`
            : row.contentDisposition,
        }),
      );
    });

    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://local");
      if (url.pathname === "/") {
        if (request.method === "PUT" && url.searchParams.has("pathname")) {
          return yield* handlePut(request, url);
        }
        if (request.method === "GET" && url.searchParams.has("url")) {
          return yield* handleHead(request, url);
        }
        if (request.method === "GET") {
          return yield* handleList(request, url);
        }
      }
      if (request.method === "POST" && url.pathname === "/delete") {
        return yield* handleDelete(request);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return yield* handleContent(request, url);
      }
      return errorJson(404, "not_found", "Unknown local blob route");
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("[alchemy dev] local blob server error", cause),
          errorJson(500, "internal_server_error", "local blob server error"),
        ),
      ),
    );

    // A bind failure on an ephemeral port is unrecoverable dev machinery
    // damage — die rather than surface an error the engine can't act on.
    const context = (yield* Layer.build(httpServer(0, "127.0.0.1")).pipe(
      Effect.orDie,
    )) as Context.Context<HttpServer.HttpServer>;
    const server = Context.get(context, HttpServer.HttpServer);
    yield* Effect.orDie(server.serve(handler));
    const serverUrl = HttpServer.formatAddress(server.address)
      .replace("127.0.0.1", "localhost")
      .replace(/\/$/, "");

    const openStore = Effect.fn(function* (input: {
      readonly storeId: string;
      readonly access: BlobStoreAccess;
    }) {
      const slug = localStoreSlug(input.storeId);
      const existing = bySlug(slug);
      if (existing !== undefined) {
        if (existing.handle.access === input.access) return existing.handle;
        // Access-mode change: swap the handle in place (the local provider
        // treats access as an in-place update — replacing would nuke the
        // shared directory out from under the successor generation).
        const swapped: StoreEntry = {
          ...existing,
          handle: { ...existing.handle, access: input.access },
        };
        stores.set(slug, swapped);
        yield* Effect.orDie(persistIndex(swapped));
        return swapped.handle;
      }
      const secret = (yield* sha256(`alchemy-local-blob:${slug}`)).slice(0, 24);
      const handle: LocalBlobStoreHandle = {
        storeId: input.storeId,
        slug,
        access: input.access,
        token: `vercel_blob_rw_${slug}_${secret}`,
      };
      const directory = storeDirectory(input.storeId);
      yield* Effect.orDie(
        fs.makeDirectory(path.join(directory, OBJECTS_DIR), {
          recursive: true,
        }),
      );
      const blobs = new Map<string, BlobRow>();
      // Hydrate from a previous dev session's index (best-effort — a
      // corrupt index starts the store empty rather than failing dev).
      const index = yield* fs
        .readFileString(path.join(directory, INDEX_FILE))
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (index !== undefined) {
        try {
          const parsed = JSON.parse(index) as { blobs?: BlobRow[] };
          for (const row of parsed.blobs ?? []) {
            if (typeof row?.pathname === "string") blobs.set(row.pathname, row);
          }
        } catch {
          // start empty
        }
      }
      stores.set(slug, {
        handle,
        directory,
        blobs,
        lock: Semaphore.makeUnsafe(1),
      });
      return handle;
    });

    const dropStore = Effect.fn(function* (storeId: string) {
      const entry = byStoreId(storeId);
      if (entry !== undefined) stores.delete(entry.handle.slug);
      yield* fs
        .remove(storeDirectory(storeId), { recursive: true })
        .pipe(Effect.ignore);
    });

    const hasStore = (storeId: string) =>
      Effect.sync(() => byStoreId(storeId) !== undefined);

    return {
      url: serverUrl,
      openStore,
      dropStore,
      hasStore,
    } satisfies LocalBlobServer;
  },
);

/** Effect requirements of {@link makeLocalBlobServer}. */
export type LocalBlobServerRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;
