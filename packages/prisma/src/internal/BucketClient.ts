/**
 * Runtime half of the Prisma Object Store bindings: a small S3 client for the
 * operations the bindings use, signed with SigV4 against a bucket key's
 * endpoint. Internal — the capability modules (`ReadBucket.ts`,
 * `WriteBucket.ts`, `ReadWriteBucket.ts`) build their public clients on top of
 * it.
 *
 * Prisma buckets are served by Tigris. Every request here (`GetObject`,
 * `HeadObject`, `PutObject`, `DeleteObject`, `ListObjectsV2`, presigned GET and
 * PUT) is one Prisma documents as supported.
 */
import * as AwsClient from "@distilled.cloud/aws4signer/AwsClient";
import { parseXml, type XmlValue } from "@distilled.cloud/core/xml";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Stream from "effect/Stream";
import {
  BucketError,
  type BucketBody,
  type BucketCredentials,
  type BucketObject,
  type BucketObjectBody,
  type BucketRange,
  type GetOptions,
  type ListOptions,
  type ListResult,
  type PutOptions,
} from "../BucketTypes.ts";

/**
 * SigV4 credential scope used for Prisma Object Store requests. Prisma
 * addresses buckets through a single regionless endpoint and does not report
 * a region on a bucket key, so requests are signed under the `auto` scope
 * that S3-compatible stores conventionally accept.
 */
export const BUCKET_SIGNING_REGION = "auto";

const DEFAULT_PRESIGN_EXPIRES_IN = 900;

export type PresignRequest =
  | {
      method: "GET";
      key: string;
      expiresIn?: number | undefined;
      /** Signed `response-content-type` override for the download. */
      responseContentType?: string | undefined;
    }
  | {
      method: "PUT";
      key: string;
      expiresIn?: number | undefined;
      /** `Content-Type` header the uploader must send, signed into the URL. */
      contentType?: string | undefined;
    };

/**
 * The S3 operations a capability client is built from, bound to one bucket
 * key's endpoint, bucket and credentials.
 */
export interface BucketAccess {
  /** `HeadObject`. Resolves `null` when the key does not exist. */
  headObject: (key: string) => Effect.Effect<BucketObject | null, BucketError>;
  /** `GetObject`. Resolves `null` when the key does not exist. */
  getObject: (
    key: string,
    options?: GetOptions,
  ) => Effect.Effect<BucketObjectBody | null, BucketError>;
  /** `PutObject`. */
  putObject: (
    key: string,
    value: BucketBody,
    options?: PutOptions,
  ) => Effect.Effect<BucketObject, BucketError>;
  /** `DeleteObject`. Deleting a key that does not exist succeeds. */
  deleteObject: (key: string) => Effect.Effect<void, BucketError>;
  /** One page of `ListObjectsV2`. */
  listObjects: (options?: ListOptions) => Effect.Effect<ListResult, BucketError>;
  /** SigV4 query-string presigning. No request is sent. */
  presign: (request: PresignRequest) => Effect.Effect<string, BucketError>;
}

/** A non-2xx response from the store, with the S3 error code when it sent one. */
export class BucketResponseError extends Data.TaggedError("BucketResponseError")<{
  message: string;
  status: number;
  code: string | undefined;
}> {}

export const toBucketError = (error: unknown): BucketError =>
  new BucketError({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown Prisma Object Store error",
    cause: error instanceof Error ? error : new Error(String(error)),
  });

/** Render a {@link BucketRange} as an HTTP `Range` header value. */
export const rangeHeader = (range: BucketRange | undefined) => {
  if (range === undefined) return undefined;
  const end = range.length === undefined ? "" : String(range.offset + range.length - 1);
  return `bytes=${range.offset}-${end}`;
};

/**
 * Percent-encode an object key for the URL path: every character except RFC
 * 3986 unreserved ones, keeping the `/` separators.
 */
export const encodeKey = (key: string) =>
  key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");

const stripQuotes = (etag: string | undefined) =>
  etag === undefined ? "" : etag.replaceAll('"', "");

const META_PREFIX = "x-amz-meta-";

const metadataFrom = (headers: Record<string, string>): Record<string, string> => {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(META_PREFIX)) metadata[name.slice(META_PREFIX.length)] = value;
  }
  return metadata;
};

const dateFrom = (value: string | undefined) => (value === undefined ? undefined : new Date(value));

const numberFrom = (value: string | undefined) => (value === undefined ? 0 : Number(value));

const objectFromHeaders = (key: string, headers: Record<string, string>): BucketObject => ({
  key,
  size: numberFrom(headers["content-length"]),
  etag: stripQuotes(headers.etag),
  lastModified: dateFrom(headers["last-modified"]),
  contentType: headers["content-type"],
  metadata: metadataFrom(headers),
});

const concatBytes = (chunks: Iterable<Uint8Array>): Uint8Array => {
  const list = [...chunks];
  const total = list.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of list) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

/**
 * Wrap a `GetObject` response as a {@link BucketObjectBody}. The body is a
 * single-consumption stream, so `body` and the buffering accessors are views of
 * the same bytes and only one of them may be read.
 */
const objectBodyFrom = (
  key: string,
  response: HttpClientResponse.HttpClientResponse,
): BucketObjectBody => {
  const body = response.stream.pipe(Stream.mapError(toBucketError));
  const bytes = () => Stream.runCollect(body).pipe(Effect.map(concatBytes));
  const text = () => body.pipe(Stream.decodeText, Stream.mkString);
  return {
    ...objectFromHeaders(key, response.headers),
    body,
    bytes,
    arrayBuffer: () =>
      bytes().pipe(
        Effect.map((collected) => {
          const buffer = new ArrayBuffer(collected.byteLength);
          new Uint8Array(buffer).set(collected);
          return buffer;
        }),
      ),
    text,
    json: <T>() =>
      text().pipe(
        Effect.flatMap((decoded) =>
          Effect.try({
            try: () => JSON.parse(decoded) as T,
            catch: toBucketError,
          }),
        ),
      ),
  };
};

/** The text of an XML element that holds only text; `undefined` otherwise. */
const xmlText = (value: XmlValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const xmlList = (value: XmlValue | undefined): XmlValue[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const xmlChild = (value: XmlValue, name: string): XmlValue | undefined =>
  typeof value === "object" && !Array.isArray(value) ? value[name] : undefined;

const errorCodeOf = (body: string) =>
  body.trim() === ""
    ? Effect.undefined
    : parseXml(body).pipe(
        Effect.map((document) => xmlText(xmlChild(document.Error ?? {}, "Code"))),
        Effect.orElseSucceed(() => undefined),
      );

const responseError = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap(errorCodeOf),
    Effect.flatMap((code) =>
      Effect.fail(
        new BucketResponseError({
          message: `${operation} failed with HTTP ${response.status}${code === undefined ? "" : ` (${code})`}`,
          status: response.status,
          code,
        }),
      ),
    ),
  );

const isOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

/**
 * Bodies with a known length go out as bytes. A stream goes out as a stream
 * only when the caller gave its length; otherwise it is buffered first,
 * because S3 `PutObject` does not accept a chunked upload without a length.
 */
const requestBody = (
  value: BucketBody,
  contentType: string | undefined,
  contentLength: number | undefined,
): Effect.Effect<HttpBody.HttpBody, BucketError> => {
  if (typeof value === "string") return Effect.succeed(HttpBody.text(value, contentType));
  if (value instanceof Uint8Array) return Effect.succeed(HttpBody.uint8Array(value, contentType));
  if (value instanceof ArrayBuffer) {
    return Effect.succeed(HttpBody.uint8Array(new Uint8Array(value), contentType));
  }
  if (value instanceof Blob) {
    return Effect.tryPromise({
      try: () => value.arrayBuffer(),
      catch: toBucketError,
    }).pipe(Effect.map((buffer) => HttpBody.uint8Array(new Uint8Array(buffer), contentType)));
  }
  const stream: Stream.Stream<Uint8Array, unknown> =
    value instanceof ReadableStream
      ? Stream.fromReadableStream({ evaluate: () => value, onError: (error) => error })
      : value;
  if (contentLength !== undefined) {
    return Effect.succeed(HttpBody.stream(stream, contentType, contentLength));
  }
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => HttpBody.uint8Array(concatBytes(chunks), contentType)),
    Effect.mapError(toBucketError),
  );
};

const putHeaders = (options: PutOptions | undefined): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (options?.cacheControl !== undefined) headers["cache-control"] = options.cacheControl;
  if (options?.contentDisposition !== undefined) {
    headers["content-disposition"] = options.contentDisposition;
  }
  if (options?.contentEncoding !== undefined) {
    headers["content-encoding"] = options.contentEncoding;
  }
  for (const [name, value] of Object.entries(options?.metadata ?? {})) {
    headers[`${META_PREFIX}${name}`] = value;
  }
  return headers;
};

const listResultFrom = (body: string) =>
  parseXml(body).pipe(
    Effect.map((document): ListResult => {
      const result = document.ListBucketResult ?? {};
      const objects = xmlList(xmlChild(result, "Contents")).map((entry): BucketObject => ({
        key: xmlText(xmlChild(entry, "Key")) ?? "",
        size: numberFrom(xmlText(xmlChild(entry, "Size"))),
        etag: stripQuotes(xmlText(xmlChild(entry, "ETag"))),
        lastModified: dateFrom(xmlText(xmlChild(entry, "LastModified"))),
        contentType: undefined,
        metadata: {},
      }));
      const delimitedPrefixes = xmlList(xmlChild(result, "CommonPrefixes")).flatMap((entry) => {
        const prefix = xmlText(xmlChild(entry, "Prefix"));
        return prefix === undefined ? [] : [prefix];
      });
      const cursor = xmlText(xmlChild(result, "NextContinuationToken"));
      return xmlText(xmlChild(result, "IsTruncated")) === "true" && cursor
        ? { objects, delimitedPrefixes, truncated: true, cursor }
        : { objects, delimitedPrefixes, truncated: false };
    }),
  );

/**
 * Build the operations for a bound bucket key. Buckets are addressed
 * path-style (`<endpoint>/<bucket>/<key>`), as Prisma's own Console does.
 */
export const makeBucketAccess = (credentials: BucketCredentials): BucketAccess => {
  const resolved = Effect.all({
    endpoint: credentials.endpoint,
    bucket: credentials.bucketName,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  });

  const bucketUrl = resolved.pipe(
    Effect.map(({ endpoint, bucket }) => `${endpoint.replace(/\/+$/, "")}/${bucket}`),
  );
  const objectUrl = (key: string) =>
    bucketUrl.pipe(Effect.map((url) => `${url}/${encodeKey(key)}`));

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    resolved.pipe(
      Effect.flatMap(({ accessKeyId, secretAccessKey }) =>
        HttpClient.HttpClient.pipe(
          Effect.map(
            AwsClient.sign({
              credentials: { accessKeyId, secretAccessKey },
              service: "s3",
              region: BUCKET_SIGNING_REGION,
            }),
          ),
          Effect.flatMap((client) => client.execute(request)),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
    );

  return {
    headObject: (key) =>
      objectUrl(key).pipe(
        Effect.flatMap((url) => send(HttpClientRequest.head(url))),
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(null)
            : isOk(response)
              ? Effect.succeed(objectFromHeaders(key, response.headers))
              : responseError("HeadObject", response),
        ),
        Effect.mapError(toBucketError),
      ),
    getObject: (key, options) =>
      objectUrl(key).pipe(
        Effect.map((url) => {
          const range = rangeHeader(options?.range);
          const request = HttpClientRequest.get(url);
          return range === undefined
            ? request
            : HttpClientRequest.setHeader(request, "range", range);
        }),
        Effect.flatMap(send),
        Effect.flatMap((response) => {
          if (isOk(response)) return Effect.succeed(objectBodyFrom(key, response));
          if (response.status !== 404) return responseError("GetObject", response);
          // A missing bucket is also a 404; only a missing key is absence.
          return responseError("GetObject", response).pipe(
            Effect.catchTag("BucketResponseError", (error) =>
              error.code === "NoSuchBucket" ? Effect.fail(error) : Effect.succeed(null),
            ),
          );
        }),
        Effect.mapError(toBucketError),
      ),
    putObject: (key, value, options) =>
      Effect.all([
        objectUrl(key),
        requestBody(value, options?.contentType, options?.contentLength),
      ]).pipe(
        Effect.flatMap(([url, body]) =>
          send(
            HttpClientRequest.put(url).pipe(
              HttpClientRequest.setHeaders(putHeaders(options)),
              HttpClientRequest.setBody(body),
            ),
          ),
        ),
        Effect.flatMap((response) =>
          isOk(response)
            ? Effect.succeed<BucketObject>({
                key,
                size: options?.contentLength ?? 0,
                etag: stripQuotes(response.headers.etag),
                lastModified: undefined,
                contentType: options?.contentType,
                metadata: { ...options?.metadata },
              })
            : responseError("PutObject", response),
        ),
        Effect.mapError(toBucketError),
      ),
    deleteObject: (key) =>
      objectUrl(key).pipe(
        Effect.flatMap((url) => send(HttpClientRequest.delete(url))),
        Effect.flatMap((response) =>
          isOk(response) || response.status === 404
            ? Effect.void
            : responseError("DeleteObject", response),
        ),
        Effect.mapError(toBucketError),
      ),
    listObjects: (options) =>
      bucketUrl.pipe(
        Effect.map((url) => {
          const params = new URLSearchParams({ "list-type": "2" });
          const set = (name: string, value: string | number | undefined) => {
            if (value !== undefined) params.set(name, String(value));
          };
          set("prefix", options?.prefix);
          set("delimiter", options?.delimiter);
          set("continuation-token", options?.cursor);
          set("max-keys", options?.limit);
          set("start-after", options?.startAfter);
          return HttpClientRequest.get(`${url}?${params}`);
        }),
        Effect.flatMap(send),
        Effect.flatMap((response): Effect.Effect<ListResult, unknown> =>
          isOk(response)
            ? response.text.pipe(Effect.flatMap(listResultFrom))
            : responseError("ListObjectsV2", response),
        ),
        Effect.mapError(toBucketError),
      ),
    presign: (request) =>
      Effect.all([objectUrl(request.key), resolved]).pipe(
        Effect.flatMap(([url, { accessKeyId, secretAccessKey }]) => {
          const responseContentType =
            request.method === "GET" ? request.responseContentType : undefined;
          const target =
            responseContentType === undefined
              ? url
              : `${url}?response-content-type=${encodeURIComponent(responseContentType)}`;
          const contentType = request.method === "PUT" ? request.contentType : undefined;
          return AwsClient.presign(target, {
            credentials: { accessKeyId, secretAccessKey },
            service: "s3",
            region: BUCKET_SIGNING_REGION,
            method: request.method,
            expiresIn: request.expiresIn ?? DEFAULT_PRESIGN_EXPIRES_IN,
            headers: contentType === undefined ? undefined : { "content-type": contentType },
            // `content-type` is left out of a signature by default; a PUT URL
            // must pin it so the uploader cannot send another type.
            allHeaders: contentType !== undefined,
          });
        }),
        Effect.mapError(toBucketError),
      ),
  };
};
