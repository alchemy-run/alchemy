/**
 * Maps `@distilled.cloud/prisma/Bucket` onto the bindings' public types: Alchemy
 * names for options and results, `BucketError`, and the buffering accessors on
 * a downloaded object.
 */
import * as Bucket from "@distilled.cloud/prisma/Bucket";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  BucketError,
  type BucketBody,
  type BucketCredentials,
  type BucketObject,
  type BucketObjectBody,
  type GetOptions,
  type ListOptions,
  type ListResult,
  type PresignGetOptions,
  type PresignPutOptions,
  type PutOptions,
} from "../BucketTypes.ts";

export interface BucketAccess {
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
  presignGetObject: (
    key: string,
    options?: PresignGetOptions,
  ) => Effect.Effect<string, BucketError>;
  presignPutObject: (
    key: string,
    options?: PresignPutOptions,
  ) => Effect.Effect<string, BucketError>;
}

const toBucketError = (error: Bucket.BucketClientError | BucketError): BucketError =>
  error._tag === "BucketError"
    ? error
    : new BucketError({ message: error.message || error._tag, cause: error });

const objectBodyFrom = (object: Bucket.ObjectWithBody): BucketObjectBody => {
  const body = object.body.pipe(Stream.mapError(toBucketError));
  const bytes = () =>
    Stream.runCollect(body).pipe(
      Effect.map((chunks) => {
        const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      }),
    );
  const text = () => body.pipe(Stream.decodeText, Stream.mkString);
  return {
    ...object,
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
                message: `Object ${object.key} is not valid JSON`,
                cause: error instanceof Error ? error : new Error(String(error)),
              }),
          }),
        ),
      ),
  };
};

/** `httpClient` replaces the fetch client, for tests. */
export const makeBucketAccess = (
  credentials: BucketCredentials,
  httpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
): BucketAccess => {
  const bucket = Effect.all({
    endpoint: credentials.endpoint,
    bucket: credentials.bucketName,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  }).pipe(
    Effect.map(({ endpoint, bucket, accessKeyId, secretAccessKey }) =>
      Bucket.make({ endpoint, bucket, credentials: { accessKeyId, secretAccessKey } }),
    ),
  );

  const run = <A>(
    operation: (
      bucket: Bucket.Bucket,
    ) => Effect.Effect<A, Bucket.BucketClientError, HttpClient.HttpClient>,
  ) =>
    bucket.pipe(
      Effect.flatMap(operation),
      Effect.provide(httpClient),
      Effect.mapError(toBucketError),
    );

  return {
    headObject: (key) => run((b) => b.headObject(key)),
    getObject: (key, options) =>
      run((b) => b.getObject(key, { range: options?.range })).pipe(
        Effect.map((object) => (object === null ? null : objectBodyFrom(object))),
      ),
    putObject: (key, value, options) =>
      run((b) => b.putObject(key, value, options)).pipe(
        Effect.map(({ etag }): BucketObject => ({
          key,
          size: options?.contentLength ?? 0,
          etag,
          lastModified: undefined,
          contentType: options?.contentType,
          metadata: { ...options?.metadata },
        })),
      ),
    deleteObject: (key) => run((b) => b.deleteObject(key)),
    listObjectsV2: (options) =>
      run((b) =>
        b.listObjectsV2({
          prefix: options?.prefix,
          delimiter: options?.delimiter,
          continuationToken: options?.cursor,
          maxKeys: options?.limit,
          startAfter: options?.startAfter,
        }),
      ).pipe(
        Effect.map((page): ListResult =>
          page.isTruncated
            ? {
                objects: page.contents,
                delimitedPrefixes: page.commonPrefixes,
                truncated: true,
                cursor: page.nextContinuationToken,
              }
            : { objects: page.contents, delimitedPrefixes: page.commonPrefixes, truncated: false },
        ),
      ),
    presignGetObject: (key, options) =>
      bucket.pipe(
        Effect.flatMap((b) =>
          b.presignGetObject(key, {
            expiresIn: options?.expiresIn,
            responseContentType: options?.contentType,
          }),
        ),
        Effect.mapError(toBucketError),
      ),
    presignPutObject: (key, options) =>
      bucket.pipe(
        Effect.flatMap((b) => b.presignPutObject(key, options)),
        Effect.mapError(toBucketError),
      ),
  };
};
