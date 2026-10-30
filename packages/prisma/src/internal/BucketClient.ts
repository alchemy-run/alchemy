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
import type { SigningError } from "@distilled.cloud/aws4signer";
import * as AwsClient from "@distilled.cloud/aws4signer/AwsClient";
import { parseXml, type XmlParseError, type XmlValue } from "@distilled.cloud/core/xml";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
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
 * Prisma addresses buckets through one regionless endpoint and reports no
 * region on a bucket key, so requests are signed under the `auto` scope that
 * S3-compatible stores accept.
 */
const SIGNING_REGION = "auto";

const DEFAULT_PRESIGN_EXPIRES_IN = 900;

type PresignRequest =
  | {
      method: "GET";
      key: string;
      expiresIn?: number | undefined;
      responseContentType?: string | undefined;
    }
  | {
      method: "PUT";
      key: string;
      expiresIn?: number | undefined;
      contentType?: string | undefined;
    };

/** The S3 operations the capability clients are built from, bound to one bucket key. */
export interface S3Client {
  /** Resolves `null` when the key does not exist. */
  headObject: (key: string) => Effect.Effect<BucketObject | null, BucketError>;
  /** Resolves `null` when the key does not exist. */
  getObject: (
    key: string,
    options?: GetOptions,
  ) => Effect.Effect<BucketObjectBody | null, BucketError>;
  putObject: (
    key: string,
    value: BucketBody,
    options?: PutOptions,
  ) => Effect.Effect<BucketObject, BucketError>;
  /** Deleting a key that does not exist succeeds. */
  deleteObject: (key: string) => Effect.Effect<void, BucketError>;
  /** One page. */
  listObjectsV2: (options?: ListOptions) => Effect.Effect<ListResult, BucketError>;
  /** No request is sent. */
  presign: (request: PresignRequest) => Effect.Effect<string, BucketError>;
}

/**
 * S3 error responses, tagged with the S3 error code as the AWS SDK tags them,
 * so a `BucketError`'s `cause._tag` reads the same as before.
 */
export class NoSuchKey extends Data.TaggedError("NoSuchKey")<{
  message: string;
  status: number;
}> {}

export class NoSuchBucket extends Data.TaggedError("NoSuchBucket")<{
  message: string;
  status: number;
}> {}

/** A 404 with no S3 error body, as `HeadObject` returns. */
export class NotFound extends Data.TaggedError("NotFound")<{
  message: string;
  status: number;
}> {}

/** Any other S3 error response. */
export class S3ServiceError extends Data.TaggedError("S3ServiceError")<{
  message: string;
  status: number;
  code: string | undefined;
}> {}

export class InvalidS3Response extends Data.TaggedError("InvalidS3Response")<{
  message: string;
}> {}

type S3ResponseError = NoSuchKey | NoSuchBucket | NotFound | S3ServiceError;

type ClientError =
  | S3ResponseError
  | InvalidS3Response
  | HttpClientError.HttpClientError
  | SigningError
  | AwsClient.SignRequestError
  | XmlParseError
  | BucketError;

const toBucketError = (error: ClientError): BucketError =>
  error._tag === "BucketError"
    ? error
    : new BucketError({ message: error.message || error._tag, cause: error });

const invalidInput = (message: string) => new BucketError({ message, cause: new Error(message) });

const causeOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const rangeHeader = (range: BucketRange) => {
  const end = range.length === undefined ? "" : String(range.offset + range.length - 1);
  return `bytes=${range.offset}-${end}`;
};

/** RFC 3986 percent-encoding. Throws on a lone surrogate, which has no UTF-8 form. */
const encodeComponent = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * The URL parser resolves `.` and `..` path segments before a request is sent,
 * so such a key would address a different object, or another bucket.
 */
const encodeKey = (key: string): Effect.Effect<string, BucketError> => {
  const segments = key.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return Effect.fail(
      invalidInput(`Object key must not contain "." or ".." segments: ${JSON.stringify(key)}`),
    );
  }
  return Effect.try({
    try: () => segments.map(encodeComponent).join("/"),
    catch: () => invalidInput(`Object key is not valid UTF-16: ${JSON.stringify(key)}`),
  });
};

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

const headerDate = (value: string | undefined) => {
  const date = value === undefined ? undefined : new Date(value);
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date;
};

const objectFromHeaders = (key: string, headers: Record<string, string>): BucketObject => ({
  key,
  size: Number(headers["content-length"] ?? 0) || 0,
  etag: stripQuotes(headers.etag),
  lastModified: headerDate(headers["last-modified"]),
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
 * The body is a single-consumption stream, so `body` and the buffering
 * accessors are views of the same bytes and only one of them may be read.
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
            catch: (error) =>
              new BucketError({
                message: `Object ${key} is not valid JSON`,
                cause: causeOf(error),
              }),
          }),
        ),
      ),
  };
};

const xmlText = (value: XmlValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const xmlList = (value: XmlValue | undefined): XmlValue[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const xmlChild = (value: XmlValue | undefined, name: string): XmlValue | undefined =>
  typeof value === "object" && !Array.isArray(value) ? value[name] : undefined;

const errorDetailsOf = (body: string) =>
  body.trim() === ""
    ? Effect.succeed({ code: undefined, message: undefined })
    : parseXml(body).pipe(
        Effect.map((document) => ({
          code: xmlText(xmlChild(document.Error, "Code")),
          message: xmlText(xmlChild(document.Error, "Message")),
        })),
        Effect.orElseSucceed(() => ({ code: undefined, message: undefined })),
      );

const s3Error = (
  operation: string,
  status: number,
  code: string | undefined,
  detail: string | undefined,
): S3ResponseError => {
  const message = [
    `${operation} failed with HTTP ${status}`,
    code === undefined ? "" : ` (${code})`,
    detail === undefined ? "" : `: ${detail}`,
  ].join("");
  if (code === "NoSuchKey") return new NoSuchKey({ message, status });
  if (code === "NoSuchBucket") return new NoSuchBucket({ message, status });
  if (code === undefined && status === 404) return new NotFound({ message, status });
  return new S3ServiceError({ message, status, code });
};

const responseError = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap(errorDetailsOf),
    Effect.flatMap(({ code, message }) =>
      Effect.fail(s3Error(operation, response.status, code, message)),
    ),
  );

const ensureOk = (operation: string) => (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : responseError(operation, response);

const isTransient = (error: ClientError) =>
  (error._tag === "S3ServiceError" &&
    (error.status === 408 || error.status === 429 || error.status >= 500)) ||
  (error._tag === "HttpClientError" && error.reason._tag === "TransportError");

/**
 * Every body is sent as bytes with a known length. Effect's fetch client drops
 * `Content-Length` from a streamed body, and S3 `PutObject` rejects an upload
 * without one, so a stream is read into memory first.
 */
const requestBody = (
  value: BucketBody,
  contentType: string | undefined,
): Effect.Effect<HttpBody.HttpBody, BucketError> => {
  if (typeof value === "string") return Effect.succeed(HttpBody.text(value, contentType));
  if (value instanceof Uint8Array) return Effect.succeed(HttpBody.uint8Array(value, contentType));
  if (value instanceof ArrayBuffer) {
    return Effect.succeed(HttpBody.uint8Array(new Uint8Array(value), contentType));
  }
  const readError = (error: unknown) =>
    new BucketError({ message: "Reading the upload body failed", cause: causeOf(error) });
  if (value instanceof Blob) {
    return Effect.tryPromise({ try: () => value.arrayBuffer(), catch: readError }).pipe(
      Effect.map((buffer) => HttpBody.uint8Array(new Uint8Array(buffer), contentType)),
    );
  }
  const stream =
    value instanceof ReadableStream
      ? Stream.fromReadableStream({ evaluate: () => value, onError: readError })
      : value.pipe(Stream.mapError(readError));
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => HttpBody.uint8Array(concatBytes(chunks), contentType)),
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

const invalidList = (message: string) =>
  Effect.fail(new InvalidS3Response({ message: `ListObjectsV2 returned ${message}` }));

const listEntryFrom = (entry: XmlValue): Effect.Effect<BucketObject, InvalidS3Response> => {
  const key = xmlText(xmlChild(entry, "Key"));
  const size = Number(xmlText(xmlChild(entry, "Size")));
  const modified = xmlText(xmlChild(entry, "LastModified"));
  const lastModified = modified === undefined ? undefined : new Date(modified);
  if (key === undefined) return invalidList("an entry without a Key");
  if (!Number.isFinite(size)) return invalidList(`an invalid Size for ${key}`);
  if (lastModified !== undefined && Number.isNaN(lastModified.getTime())) {
    return invalidList(`an invalid LastModified for ${key}`);
  }
  return Effect.succeed({
    key,
    size,
    etag: stripQuotes(xmlText(xmlChild(entry, "ETag"))),
    lastModified,
    contentType: undefined,
    metadata: {},
  });
};

const listResultFrom = (body: string) =>
  parseXml(body).pipe(
    Effect.flatMap((document) => {
      const result = document.ListBucketResult;
      if (
        result === undefined ||
        Array.isArray(result) ||
        (typeof result === "string" && result.trim() !== "")
      ) {
        return invalidList("a response that is not a ListBucketResult");
      }
      const truncated = xmlText(xmlChild(result, "IsTruncated")) === "true";
      const cursor = xmlText(xmlChild(result, "NextContinuationToken"));
      if (truncated && !cursor) return invalidList("IsTruncated without a NextContinuationToken");
      const delimitedPrefixes = xmlList(xmlChild(result, "CommonPrefixes")).flatMap((entry) => {
        const prefix = xmlText(xmlChild(entry, "Prefix"));
        return prefix === undefined ? [] : [prefix];
      });
      return Effect.forEach(xmlList(xmlChild(result, "Contents")), listEntryFrom).pipe(
        Effect.map((objects): ListResult =>
          truncated && cursor
            ? { objects, delimitedPrefixes, truncated: true, cursor }
            : { objects, delimitedPrefixes, truncated: false },
        ),
      );
    }),
  );

const listQuery = (options: ListOptions | undefined) =>
  Effect.try({
    try: () =>
      (
        [
          ["list-type", 2],
          ["prefix", options?.prefix],
          ["delimiter", options?.delimiter],
          ["continuation-token", options?.cursor],
          ["max-keys", options?.limit],
          ["start-after", options?.startAfter],
        ] as const
      )
        .flatMap(([name, value]) =>
          value === undefined ? [] : [`${name}=${encodeComponent(String(value))}`],
        )
        .join("&"),
    catch: () => invalidInput("List options are not valid UTF-16"),
  });

/**
 * Build the operations for a bound bucket key. Buckets are addressed
 * path-style (`<endpoint>/<bucket>/<key>`), as Prisma's own Console does.
 * `httpClient` replaces the fetch client, for tests.
 */
export const makeS3Client = (
  credentials: BucketCredentials,
  httpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
): S3Client => {
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
    Effect.all([bucketUrl, encodeKey(key)]).pipe(Effect.map(([url, path]) => `${url}/${path}`));

  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    resolved.pipe(
      Effect.flatMap(({ accessKeyId, secretAccessKey }) =>
        HttpClient.HttpClient.pipe(
          Effect.map(
            AwsClient.sign({
              credentials: { accessKeyId, secretAccessKey },
              service: "s3",
              region: SIGNING_REGION,
            }),
          ),
          Effect.flatMap((client) => client.execute(request)),
          Effect.flatMap(ensureOk(operation)),
          Effect.retry({
            while: isTransient,
            schedule: Schedule.exponential("200 millis"),
            times: 5,
          }),
        ),
      ),
      Effect.provide(httpClient),
    );

  return {
    headObject: (key) =>
      objectUrl(key).pipe(
        Effect.flatMap((url) => send("HeadObject", HttpClientRequest.head(url))),
        Effect.map((response): BucketObject | null => objectFromHeaders(key, response.headers)),
        Effect.catchTag(["NoSuchKey", "NotFound"], () => Effect.succeed(null)),
        Effect.mapError(toBucketError),
      ),
    getObject: (key, options) =>
      objectUrl(key).pipe(
        Effect.map((url) => {
          const request = HttpClientRequest.get(url);
          return options?.range === undefined
            ? request
            : HttpClientRequest.setHeader(request, "range", rangeHeader(options.range));
        }),
        Effect.flatMap((request) => send("GetObject", request)),
        Effect.map((response): BucketObjectBody | null => objectBodyFrom(key, response)),
        Effect.catchTag(["NoSuchKey", "NotFound"], () => Effect.succeed(null)),
        Effect.mapError(toBucketError),
      ),
    putObject: (key, value, options) =>
      Effect.all([objectUrl(key), requestBody(value, options?.contentType)]).pipe(
        Effect.flatMap(([url, body]) =>
          send(
            "PutObject",
            HttpClientRequest.put(url).pipe(
              HttpClientRequest.setHeaders(putHeaders(options)),
              HttpClientRequest.setBody(body),
            ),
          ),
        ),
        Effect.map((response): BucketObject => ({
          key,
          size: options?.contentLength ?? 0,
          etag: stripQuotes(response.headers.etag),
          lastModified: undefined,
          contentType: options?.contentType,
          metadata: { ...options?.metadata },
        })),
        Effect.mapError(toBucketError),
      ),
    deleteObject: (key) =>
      objectUrl(key).pipe(
        Effect.flatMap((url) => send("DeleteObject", HttpClientRequest.delete(url))),
        Effect.asVoid,
        Effect.catchTag(["NoSuchKey", "NotFound"], () => Effect.void),
        Effect.mapError(toBucketError),
      ),
    listObjectsV2: (options) =>
      Effect.all([bucketUrl, listQuery(options)]).pipe(
        Effect.flatMap(([url, query]) =>
          send("ListObjectsV2", HttpClientRequest.get(`${url}?${query}`)),
        ),
        Effect.flatMap((response) => response.text),
        Effect.flatMap(listResultFrom),
        Effect.mapError(toBucketError),
      ),
    presign: (request) =>
      Effect.all([objectUrl(request.key), resolved]).pipe(
        Effect.flatMap(([url, { accessKeyId, secretAccessKey }]) => {
          const responseContentType =
            request.method === "GET" ? request.responseContentType : undefined;
          const contentType = request.method === "PUT" ? request.contentType : undefined;
          return Effect.try({
            try: () =>
              responseContentType === undefined
                ? url
                : `${url}?response-content-type=${encodeComponent(responseContentType)}`,
            catch: () => invalidInput("Response content type is not valid UTF-16"),
          }).pipe(
            Effect.flatMap((target) =>
              AwsClient.presign(target, {
                credentials: { accessKeyId, secretAccessKey },
                service: "s3",
                region: SIGNING_REGION,
                method: request.method,
                expiresIn: request.expiresIn ?? DEFAULT_PRESIGN_EXPIRES_IN,
                headers: contentType === undefined ? undefined : { "content-type": contentType },
                // A PUT URL pins `content-type`, which signers leave out by default.
                allHeaders: contentType !== undefined,
              }),
            ),
          );
        }),
        Effect.mapError(toBucketError),
      ),
  };
};
