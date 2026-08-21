/**
 * `Git.BlobStoreS3` — AWS S3 implementation of {@link BlobStore}.
 *
 * Runs the git service's bulk bytes (packs, clone bundles, oversize
 * objects, push spill) on an S3 bucket while compute stays on Cloudflare:
 * distilled's S3 client is SigV4 over Effect's HttpClient, so it works
 * identically in the Worker and inside the Repo DO — one provision serves
 * both runtime contexts, exactly like {@link BlobStoreR2}.
 *
 * Credentials are static access keys resolved via `Config` — at deploy
 * time from the deployer's environment (bound onto the Worker as
 * secrets), at runtime from the Worker env. Scope the IAM user to this
 * bucket (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`,
 * `s3:ListBucket`, `s3:AbortMultipartUpload` on the bucket + objects).
 *
 * Latency note: every blob operation crosses the internet to S3 (no
 * Cloudflare-internal path), so serving-path reads are slower than R2.
 * The window-coalescing in `ObjectStore`/`PackSource` keeps request
 * counts low, but R2 remains the recommended default for
 * Cloudflare-hosted assemblies.
 *
 * @section Providing the store
 * @example Packs on S3, compute on Cloudflare
 * ```typescript
 * const GitLive = Git.ServerLive.pipe(
 *   Layer.provide(Git.ReposDurableObject),
 *   Layer.provide(Git.RegistryDurableObject),
 *   Layer.provide(
 *     Git.BlobStoreS3({ bucket: "my-git-objects", region: "us-east-1" }),
 *   ),
 * );
 * ```
 */
import { fromCredentials } from "alchemy/AWS/Credentials";
import * as S3 from "@distilled.cloud/aws/s3";
import * as AwsRegion from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  BlobStore,
  BlobStoreError,
  type BlobBody,
  type BlobMeta,
  type BlobMultipart,
  type BlobStoreShape,
} from "./BlobStore.ts";

export interface BlobStoreS3Options {
  /** Bucket name (must already exist; the layer never creates it). */
  readonly bucket: string;
  /** Bucket region, e.g. `us-east-1`. */
  readonly region: string;
  /**
   * `Config` keys the access keys are read from.
   * @default AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
   */
  readonly credentials?: {
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
  };
}

const s3Error =
  (what: string) =>
  (error: { readonly _tag?: string; readonly message?: string }) =>
    new BlobStoreError({
      reason: `${what}: ${error._tag ?? "S3Error"}${
        error.message ? `: ${error.message}` : ""
      }`,
    });

const collectBytes = (
  stream: Stream.Stream<Uint8Array, Error>,
  what: string,
): Effect.Effect<Uint8Array, BlobStoreError> =>
  Stream.runCollect(stream).pipe(
    Effect.mapError((error) => s3Error(what)({ message: String(error) })),
    Effect.map((chunks) => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    }),
  );

/**
 * S3-backed {@link BlobStore}. See the module doc for credentials and
 * latency semantics.
 *
 * @layer
 * @provides Git.BlobStore
 */
export const BlobStoreS3 = (
  options: BlobStoreS3Options,
): Layer.Layer<BlobStore> =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const Bucket = options.bucket;
      const accessKeyId = yield* Config.string(
        options.credentials?.accessKeyId ?? "AWS_ACCESS_KEY_ID",
      );
      const secretAccessKey = yield* Config.redacted(
        options.credentials?.secretAccessKey ?? "AWS_SECRET_ACCESS_KEY",
      );

      // The distilled client context: static credentials + region + fetch.
      // Constructed once at layer build (cheap, no I/O) — the per-context
      // rules of RFC §2 hold on both the Worker and DO sides.
      const context = Layer.mergeAll(
        fromCredentials(
          {
            accessKeyId,
            secretAccessKey: Redacted.value(secretAccessKey),
          },
          options.region,
        ),
        AwsRegion.of(options.region as AwsRegion.RegionName),
        FetchHttpClient.layer,
      );

      const getObject = yield* S3.getObject.pipe(Effect.provide(context));
      const putObject = yield* S3.putObject.pipe(Effect.provide(context));
      const headObject = yield* S3.headObject.pipe(Effect.provide(context));
      const deleteObjects = yield* S3.deleteObjects.pipe(
        Effect.provide(context),
      );
      const listObjectsV2 = yield* S3.listObjectsV2.pipe(
        Effect.provide(context),
      );
      const createMultipart = yield* S3.createMultipartUpload.pipe(
        Effect.provide(context),
      );
      const uploadPart = yield* S3.uploadPart.pipe(Effect.provide(context));
      const completeMultipart = yield* S3.completeMultipartUpload.pipe(
        Effect.provide(context),
      );
      const abortMultipart = yield* S3.abortMultipartUpload.pipe(
        Effect.provide(context),
      );

      return {
        get: (key, range) =>
          getObject({
            Bucket,
            Key: key,
            Range:
              range === undefined
                ? undefined
                : `bytes=${range.offset}-${range.offset + range.length - 1}`,
          }).pipe(
            Effect.map((output): BlobBody | null => {
              const body = output.Body ?? Stream.empty;
              return {
                size: output.ContentLength ?? 0,
                bytes: collectBytes(body, `get ${key}`),
                stream: body.pipe(
                  Stream.mapError((error) =>
                    s3Error(`stream ${key}`)({ message: String(error) }),
                  ),
                ),
              };
            }),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(null)),
            Effect.mapError(s3Error(`get ${key}`)),
          ),

        put: (key, body, opts) =>
          putObject({
            Bucket,
            Key: key,
            Body: body instanceof Uint8Array ? body : body,
            ContentLength:
              body instanceof Uint8Array ? body.length : opts?.contentLength,
          }).pipe(Effect.mapError(s3Error(`put ${key}`)), Effect.asVoid),

        head: (key) =>
          headObject({ Bucket, Key: key }).pipe(
            Effect.map(
              (output): BlobMeta => ({
                key,
                size: output.ContentLength ?? 0,
              }),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed(null)),
            Effect.mapError(s3Error(`head ${key}`)),
          ),

        multipart: (key) =>
          createMultipart({ Bucket, Key: key }).pipe(
            Effect.mapError(s3Error(`multipart ${key}`)),
            Effect.map((created) => {
              const UploadId = created.UploadId ?? "";
              const parts: Array<{ PartNumber: number; ETag?: string }> = [];
              return {
                uploadPart: (partNumber, part) =>
                  uploadPart({
                    Bucket,
                    Key: key,
                    UploadId,
                    PartNumber: partNumber,
                    Body: part,
                    ContentLength: part.length,
                  }).pipe(
                    Effect.mapError(s3Error(`part ${partNumber} of ${key}`)),
                    Effect.map((uploaded) => {
                      parts.push({
                        PartNumber: partNumber,
                        ETag: uploaded.ETag,
                      });
                    }),
                  ),
                complete: Effect.suspend(() =>
                  completeMultipart({
                    Bucket,
                    Key: key,
                    UploadId,
                    MultipartUpload: {
                      Parts: [...parts].sort(
                        (a, b) => a.PartNumber - b.PartNumber,
                      ),
                    },
                  }),
                ).pipe(
                  Effect.mapError(s3Error(`complete ${key}`)),
                  Effect.asVoid,
                ),
                abort: abortMultipart({ Bucket, Key: key, UploadId }).pipe(
                  Effect.mapError(s3Error(`abort ${key}`)),
                  Effect.asVoid,
                ),
              } satisfies BlobMultipart;
            }),
          ),

        delete: (keys) => {
          const list = typeof keys === "string" ? [keys] : [...keys];
          if (list.length === 0) return Effect.void;
          return deleteObjects({
            Bucket,
            Delete: {
              Objects: list.map((Key) => ({ Key })),
              Quiet: true,
            },
          }).pipe(Effect.mapError(s3Error("delete")), Effect.asVoid);
        },

        list: (prefix) =>
          Stream.paginate(
            undefined as string | undefined,
            (ContinuationToken) =>
              listObjectsV2({
                Bucket,
                Prefix: prefix,
                ContinuationToken,
                MaxKeys: 1000,
              }).pipe(
                Effect.mapError(s3Error(`list ${prefix}`)),
                Effect.map((page) => {
                  const metas = (page.Contents ?? []).flatMap(
                    (object): Array<BlobMeta> =>
                      object.Key === undefined
                        ? []
                        : [{ key: object.Key, size: object.Size ?? 0 }],
                  );
                  return [
                    metas,
                    page.IsTruncated && page.NextContinuationToken
                      ? Option.some(page.NextContinuationToken)
                      : Option.none<string>(),
                  ] as const;
                }),
              ),
          ),
      } satisfies BlobStoreShape;
    }),
  ) as never;
