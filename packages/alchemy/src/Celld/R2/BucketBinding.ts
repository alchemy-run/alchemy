import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { WorkerEnvironment } from "../../Workers/Worker.ts";
import { storageBinding } from "../KV/StorageBinding.ts";
import { Worker } from "../Worker.ts";
import type { Bucket } from "./Bucket.ts";
import {
  R2Error,
  type Conditional,
  type NativeBucket,
  type NativeObject,
  type NativeObjectBody,
  type ObjectBody,
  type R2Object,
} from "./BucketTypes.ts";

/** Shared, internal registration for Celld's native bucket clients. */
export const makeR2BucketBinding = <Client>(options: {
  makeClient: (helpers: ReturnType<typeof makeR2BucketHelpers>) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;
    return Effect.fn(function* (bucket: Bucket) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${bucket}`({
          storageBindings: [storageBinding(bucket)],
          bindings: [
            {
              type: "r2_bucket",
              name: bucket.LogicalId,
              bucketName: bucket.bucketName,
            },
          ],
        });
      }
      return options.makeClient(makeR2BucketHelpers(env, bucket));
    });
  });

const r2Error = (cause: unknown) =>
  new R2Error({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Reject options the 0.5 harness would otherwise silently ignore. */
export const validateR2Options = (options?: {
  ssecKey?: ArrayBuffer | string;
  onlyIf?: Conditional | Headers;
}) => {
  if (options?.ssecKey !== undefined) {
    throw new Error(
      "Celld 0.5 R2 does not support customer-key encryption (ssecKey)",
    );
  }
  if (
    options?.onlyIf &&
    "secondsGranularity" in options.onlyIf &&
    options.onlyIf.secondsGranularity !== undefined
  ) {
    throw new Error(
      "Celld 0.5 R2 does not support secondsGranularity conditions",
    );
  }
};

/** Resolve only the environment binding at call time; no request I/O is retained. */
export const makeR2BucketHelpers = (
  env: Record<string, unknown>,
  bucket: Pick<Bucket, "LogicalId">,
) => {
  const raw = Effect.suspend(() => {
    const binding = env[bucket.LogicalId] as NativeBucket | undefined;
    return binding
      ? Effect.succeed(binding)
      : Effect.fail(
          new R2Error({
            message: `Missing Celld R2 binding '${bucket.LogicalId}'`,
            cause: undefined,
          }),
        );
  });
  const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, R2Error> =>
    Effect.tryPromise({ try: fn, catch: r2Error });
  const trySync = <T>(fn: () => T): Effect.Effect<T, R2Error> =>
    Effect.try({ try: fn, catch: r2Error });
  const use = <T>(fn: (binding: NativeBucket) => Promise<T>) =>
    raw.pipe(Effect.flatMap((binding) => tryPromise(() => fn(binding))));

  const wrapR2Object = (object: NativeObject): R2Object => ({
    key: object.key,
    version: object.version,
    size: object.size,
    etag: object.etag,
    httpEtag: object.httpEtag,
    uploaded: object.uploaded,
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
    checksums: object.checksums,
    storageClass: object.storageClass,
    ...(object.range === undefined ? {} : { range: object.range }),
    writeHttpMetadata: (headers) =>
      trySync(() => object.writeHttpMetadata(headers)),
  });
  const wrapR2ObjectBody = (object: NativeObjectBody): ObjectBody => ({
    ...wrapR2Object(object),
    body: Stream.fromReadableStream({
      evaluate: () => object.body,
      onError: r2Error,
    }),
    readable: object.body,
    get bodyUsed() {
      return object.bodyUsed;
    },
    arrayBuffer: () => tryPromise(() => object.arrayBuffer()),
    bytes: () => tryPromise(() => object.bytes()),
    text: () => tryPromise(() => object.text()),
    json: <T>() => tryPromise(() => object.json<T>()),
    blob: () => tryPromise(() => object.blob()),
  });
  const wrapR2ObjectOrBody = (
    object: NativeObject | NativeObjectBody | null,
  ): R2Object | ObjectBody | null =>
    object === null
      ? null
      : "body" in object
        ? wrapR2ObjectBody(object)
        : wrapR2Object(object);

  return { raw, use, tryPromise, trySync, wrapR2Object, wrapR2ObjectOrBody };
};
