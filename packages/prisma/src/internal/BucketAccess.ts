/**
 * Maps `@distilled.cloud/prisma/BucketObjects` onto the bindings' public types: Alchemy
 * names for options and results, `BucketError`, and the buffering accessors on
 * a downloaded object.
 */
import * as BucketObjects from "@distilled.cloud/prisma/BucketObjects";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
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

/**
 * Every operation the bindings expose, over one bucket key. `deleteKey` takes
 * one key; the bindings' `delete` fans out over several.
 */
export interface BucketAccess {
  head: (key: string) => Effect.Effect<BucketObject | null, BucketError>;
  get: (key: string, options?: GetOptions) => Effect.Effect<BucketObjectBody | null, BucketError>;
  put: (
    key: string,
    value: BucketBody,
    options?: PutOptions,
  ) => Effect.Effect<BucketObject, BucketError>;
  deleteKey: (key: string) => Effect.Effect<void, BucketError>;
  list: (options?: ListOptions) => Effect.Effect<ListResult, BucketError>;
  presignGet: (key: string, options?: PresignGetOptions) => Effect.Effect<string, BucketError>;
  presignPut: (key: string, options?: PresignPutOptions) => Effect.Effect<string, BucketError>;
}

const toBucketError = (error: BucketObjects.ClientError | BucketError): BucketError =>
  error._tag === "BucketError"
    ? error
    : new BucketError({ message: error.message || error._tag, cause: error });

const objectBodyFrom = (object: BucketObjects.ObjectWithBody): BucketObjectBody => {
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

export const makeBucketAccess = (credentials: BucketCredentials): BucketAccess => {
  const bucket = Effect.all({
    endpoint: credentials.endpoint,
    bucket: credentials.bucketName,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  }).pipe(
    Effect.map(({ endpoint, bucket, accessKeyId, secretAccessKey }) =>
      BucketObjects.make({ endpoint, bucket, credentials: { accessKeyId, secretAccessKey } }),
    ),
  );

  const run = <A>(
    operation: (
      bucket: BucketObjects.Client,
    ) => Effect.Effect<A, BucketObjects.ClientError, HttpClient.HttpClient>,
  ) =>
    bucket.pipe(
      Effect.flatMap(operation),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(toBucketError),
    );

  return {
    head: (key) => run((b) => b.headObject(key)),
    get: (key, options) =>
      run((b) => b.getObject(key, { range: options?.range })).pipe(
        Effect.map((object) => (object === null ? null : objectBodyFrom(object))),
      ),
    put: (key, value, options) =>
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
    deleteKey: (key) => run((b) => b.deleteObject(key)),
    list: (options) =>
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
    presignGet: (key, options) =>
      bucket.pipe(
        Effect.flatMap((b) =>
          b.presignGetObject(key, {
            expiresIn: options?.expiresIn,
            responseContentType: options?.contentType,
          }),
        ),
        Effect.mapError(toBucketError),
      ),
    presignPut: (key, options) =>
      bucket.pipe(
        Effect.flatMap((b) => b.presignPutObject(key, options)),
        Effect.mapError(toBucketError),
      ),
  };
};
