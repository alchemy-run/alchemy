/**
 * Promise-based Blob client for **plain async Functions** (no Effect
 * runtime shipped in the bundle). Deliberately dependency-free (plain
 * `fetch`) so bundling it into an async Function stays cheap and safe.
 * For Effect code use the `ReadBlob`/`WriteBlob`/`ReadWriteBlob` bindings.
 */
import type {
  BlobListItem,
  BlobObject,
  ListBlobsOptions,
  ListBlobsResult,
  PutBlobBody,
  PutBlobOptions,
  PutBlobResult,
} from "./BlobTypes.ts";

const DEFAULT_BLOB_API_URL = "https://blob.vercel-storage.com";
const BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";
const BLOB_API_VERSION = "12";

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
  /** Data-plane endpoint override (defaults to `VERCEL_BLOB_API_URL` or the public endpoint). */
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

const encodePathname = (pathname: string): string =>
  pathname.split("/").map(encodeURIComponent).join("/");

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

const raise = async (operation: string, res: Response): Promise<never> => {
  const body = await res.text();
  let message = body !== "" ? body : `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    message = parsed?.error?.message ?? message;
  } catch {
    // non-JSON error body — keep the raw text
  }
  throw new Error(
    `Vercel.readWriteBlobFromEnv: ${operation} failed with ${res.status}: ${message}`,
  );
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
  const apiUrl = () =>
    options?.apiUrl ?? process.env.VERCEL_BLOB_API_URL ?? DEFAULT_BLOB_API_URL;
  const blobUrl = (token: string, pathname: string) =>
    `https://${storeIdOfToken(token).toLowerCase()}.${access}.blob.vercel-storage.com/${encodePathname(pathname)}`;
  // With a data-plane override (`VERCEL_BLOB_API_URL`, dev-mode emulation)
  // content is served by the override host under
  // `/{storeIdLower}.{access}/{pathname}` instead of the canonical host.
  const contentUrl = (token: string, pathname: string) => {
    const base = apiUrl();
    return base === DEFAULT_BLOB_API_URL
      ? blobUrl(token, pathname)
      : `${base}/${storeIdOfToken(token).toLowerCase()}.${access}/${encodePathname(pathname)}`;
  };
  const headers = (token: string, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    "x-api-version": BLOB_API_VERSION,
    ...extra,
  });

  return {
    async put(pathname, body, putOptions) {
      const token = resolveToken(options);
      const res = await fetch(
        `${apiUrl()}/?pathname=${encodeURIComponent(pathname)}`,
        {
          method: "PUT",
          headers: headers(token, {
            "x-vercel-blob-access": access,
            "content-type":
              putOptions?.contentType ?? "application/octet-stream",
            ...(putOptions?.ifMatch !== undefined
              ? { "x-if-match": putOptions.ifMatch }
              : {}),
            // The data plane's WIRE default (header absent) is to REFUSE
            // overwrites — send the header explicitly so the documented
            // client default (`allowOverwrite: true`) actually overwrites,
            // matching the Effect client (`putBlobRaw`).
            "x-allow-overwrite":
              putOptions?.allowOverwrite === false ? "0" : "1",
          }),
          body: body as BodyInit,
        },
      );
      if (!res.ok) return raise("put", res);
      return (await res.json()) as PutBlobResult;
    },
    async head(pathname) {
      const token = resolveToken(options);
      const res = await fetch(
        `${apiUrl()}/?url=${encodeURIComponent(blobUrl(token, pathname))}`,
        { headers: headers(token) },
      );
      if (!res.ok) return raise("head", res);
      const json = (await res.json()) as Omit<BlobObject, "uploadedAt"> & {
        uploadedAt: string;
      };
      return { ...json, uploadedAt: new Date(json.uploadedAt) };
    },
    async get(pathname) {
      const token = resolveToken(options);
      const url = contentUrl(token, pathname);
      const res = await fetch(url, { headers: headers(token) });
      if (!res.ok) return raise("get", res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        pathname,
        url,
        contentType: res.headers.get("content-type") ?? undefined,
        etag: res.headers.get("etag") ?? undefined,
        size: bytes.byteLength,
        bytes,
        text: new TextDecoder().decode(bytes),
      };
    },
    async list(listOptions) {
      const token = resolveToken(options);
      const params = new URLSearchParams();
      if (listOptions?.prefix !== undefined)
        params.set("prefix", listOptions.prefix);
      if (listOptions?.limit !== undefined)
        params.set("limit", String(listOptions.limit));
      if (listOptions?.cursor !== undefined)
        params.set("cursor", listOptions.cursor);
      const query = params.toString();
      const res = await fetch(
        `${apiUrl()}/${query === "" ? "" : `?${query}`}`,
        { headers: headers(token) },
      );
      if (!res.ok) return raise("list", res);
      const json = (await res.json()) as {
        hasMore: boolean;
        cursor?: string;
        blobs: Array<Omit<BlobListItem, "uploadedAt"> & { uploadedAt: string }>;
      };
      return {
        hasMore: json.hasMore,
        cursor: json.cursor,
        blobs: json.blobs.map((blob) => ({
          ...blob,
          uploadedAt: new Date(blob.uploadedAt),
        })),
      };
    },
    async del(pathnames) {
      const token = resolveToken(options);
      const list = typeof pathnames === "string" ? [pathnames] : pathnames;
      const urls = list.map((pathname) =>
        // Accept full content URLs (canonical https, or the local
        // emulator's http form) as well as bare pathnames.
        /^https?:\/\//.test(pathname) ? pathname : blobUrl(token, pathname),
      );
      const res = await fetch(`${apiUrl()}/delete`, {
        method: "POST",
        headers: headers(token, { "content-type": "application/json" }),
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) return raise("del", res);
      await res.text();
    },
  };
};
