import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Retry } from "@distilled.cloud/aws/Retry";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { requireHost } from "./Fleet.ts";
import { FleetStorage, FleetStorageError, type Store } from "./FleetStorage.ts";
import type { FleetBucket } from "./Host.ts";

const failure = (message: string, cause: unknown) =>
  new FleetStorageError({
    reason: "transport",
    message,
    cause,
  });

/** Build a client over the generated S3 SDK; conditional writes are never replayed. */
export const makeS3Store = (
  bucket: FleetBucket,
  credentials: Record<string, string>,
  http: HttpClient.HttpClient,
): Effect.Effect<Store, FleetStorageError> =>
  Effect.gen(function* () {
    const match = /^s3:\/\/([^/]+)$/.exec(bucket.uri);
    if (
      !match ||
      !credentials.AWS_ACCESS_KEY_ID ||
      !credentials.AWS_SECRET_ACCESS_KEY
    ) {
      return yield* new FleetStorageError({
        reason: "configuration",
        message:
          "Celld storage requires an s3://bucket URI and resolved storage credentials.",
      });
    }
    const name = match[1];
    const services = Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(Retry, { while: () => false }),
      Layer.succeed(
        Credentials,
        Effect.succeed({
          accessKeyId: Redacted.make(credentials.AWS_ACCESS_KEY_ID),
          secretAccessKey: Redacted.make(credentials.AWS_SECRET_ACCESS_KEY),
          sessionToken: credentials.AWS_SESSION_TOKEN
            ? Redacted.make(credentials.AWS_SESSION_TOKEN)
            : undefined,
          region:
            bucket.region ??
            credentials.AWS_REGION ??
            credentials.AWS_DEFAULT_REGION ??
            "us-east-1",
        }),
      ),
      bucket.endpoint ? Endpoint.of(bucket.endpoint) : Layer.empty,
    );

    const get: Store["get"] = Effect.fn(function* (key) {
      const result = yield* S3.getObject({ Bucket: name, Key: key }).pipe(
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
        Effect.mapError((error) =>
          failure(`Cannot read Celld object '${key}'.`, error),
        ),
        Effect.provide(services),
      );
      if (!result) return undefined;
      if (!result.ETag || !result.Body) {
        return yield* new FleetStorageError({
          reason: "configuration",
          message: `Object '${key}' has no body or conditional-write ETag.`,
        });
      }
      const chunks = yield* Stream.runCollect(result.Body).pipe(
        Effect.mapError((error) =>
          failure(`Cannot read the body of Celld object '${key}'.`, error),
        ),
      );
      const body = yield* Effect.sync(() => {
        const bytes = new Uint8Array(
          chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
        );
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      });
      return { body, etag: result.ETag };
    });

    const put: Store["put"] = Effect.fn(function* (key, body, condition) {
      if (condition?.ifMatch && condition.ifNoneMatch) {
        return yield* new FleetStorageError({
          reason: "configuration",
          message: "A write cannot require both presence and absence.",
        });
      }
      const result = yield* S3.putObject({
        Bucket: name,
        Key: key,
        Body: body,
        IfMatch: condition?.ifMatch,
        IfNoneMatch: condition?.ifNoneMatch ? "*" : undefined,
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PreconditionFailed" ||
          error._tag === "ConditionalRequestConflict"
            ? new FleetStorageError({
                reason: "conflict",
                message: `Celld object '${key}' changed concurrently.`,
                cause: error,
              })
            : failure(`Cannot publish Celld object '${key}'.`, error),
        ),
        Effect.provide(services),
      );
      if (!result.ETag) {
        return yield* new FleetStorageError({
          reason: "configuration",
          message: `Object store omitted the ETag after writing '${key}'; observe before retrying.`,
        });
      }
      return { etag: result.ETag };
    });

    const remove: Store["delete"] = Effect.fn(function* (key, condition) {
      yield* S3.deleteObject({
        Bucket: name,
        Key: key,
        IfMatch: condition?.ifMatch,
      }).pipe(
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
        Effect.mapError((error) =>
          failure(`Cannot delete Celld object '${key}'.`, error),
        ),
        Effect.provide(services),
      );
    });

    const list: Store["list"] = Effect.fn(function* (prefix) {
      const objects: { key: string; etag: string }[] = [];
      const tokens = new Set<string>();
      let token: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const result = yield* S3.listObjectsV2({
          Bucket: name,
          Prefix: prefix,
          ContinuationToken: token,
        }).pipe(
          Effect.mapError((error) =>
            failure(`Cannot list Celld objects under '${prefix}'.`, error),
          ),
          Effect.provide(services),
        );
        for (const object of result.Contents ?? []) {
          if (!object.Key || !object.ETag) {
            return yield* new FleetStorageError({
              reason: "configuration",
              message: "Object listing omitted a key or ETag.",
            });
          }
          objects.push({ key: object.Key, etag: object.ETag });
        }
        if (!result.IsTruncated) return objects;
        token = result.NextContinuationToken;
        if (!token || tokens.has(token)) {
          return yield* new FleetStorageError({
            reason: "configuration",
            message:
              "Object store returned a missing or repeated pagination token.",
          });
        }
        tokens.add(token);
      }
      return yield* new FleetStorageError({
        reason: "configuration",
        message: "Celld object listing exceeded 1,000 pages.",
      });
    });
    return { get, put, delete: remove, list };
  });

export const FleetStorageS3 = Layer.effect(
  FleetStorage,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (connection) {
      if (!connection.bucket) {
        return yield* new FleetStorageError({
          reason: "configuration",
          message: "The Celld fleet has no backing bucket.",
        });
      }
      const host = yield* requireHost("storage").pipe(
        Effect.mapError(
          (cause) =>
            new FleetStorageError({
              reason: "configuration",
              message: cause.message,
              cause,
            }),
        ),
      );
      const credentials = yield* host
        .deployEnv({ news: connection })
        .pipe(
          Effect.mapError((cause) =>
            failure("Cannot resolve Celld storage credentials.", cause),
          ),
        );
      return yield* makeS3Store(connection.bucket, credentials, http);
    });
  }),
);
