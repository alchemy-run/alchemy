import type * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Presign from "@distilled.cloud/aws/Presign";
import type { PresignError } from "@distilled.cloud/aws/Presign";
import type * as Region from "@distilled.cloud/aws/Region";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Bucket } from "./Bucket.ts";

export interface PresignPutObjectRequest {
  /**
   * Key of the object to mint a presigned upload URL for.
   */
  key: string;
  /**
   * Number of seconds the URL remains valid.
   * @default 900
   */
  expiresIn?: number;
  /**
   * Content-Type signed into the URL. The uploader must send exactly this
   * `Content-Type` header or S3 rejects the upload with a signature
   * mismatch. Omit to leave the Content-Type unconstrained.
   */
  contentType?: string;
}

/**
 * Mint presigned upload (PUT) URLs for objects in a {@link Bucket}.
 *
 * Presigning is a pure SigV4 computation performed client-side with the
 * Function's own credentials — no S3 API call is made. Because the URL
 * inherits the signer's IAM permissions, the binding grants `s3:PutObject`
 * on the bucket's objects to the host Function.
 *
 * ### Presigning Upload URLs
 * **Example:** Mint a presigned PUT URL
 * ```typescript
 * const presignPutObject = yield* S3.PresignPutObject(bucket);
 * const url = yield* presignPutObject({ key: "uploads/avatar.png" });
 * // hand `url` to a browser — it can PUT the object without AWS credentials
 * ```
 *
 * **Example:** Pin the uploaded Content-Type
 * ```typescript
 * const url = yield* presignPutObject({
 *   key: "uploads/avatar.png",
 *   expiresIn: 300, // valid for 5 minutes
 *   contentType: "image/png", // uploader must send Content-Type: image/png
 * });
 * ```
 *
 * @binding
 */
export interface PresignPutObject extends Binding.Service<
  PresignPutObject,
  "AWS.S3.PresignPutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<(request: PresignPutObjectRequest) => Effect.Effect<string, PresignError>>
> {}

export const PresignPutObject = Binding.Service<PresignPutObject>("AWS.S3.PresignPutObject");

export const PresignPutObjectHttp = Layer.effect(
  PresignPutObject,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const services = yield* AWSBindings.withCredentials(
      Effect.context<Credentials.Credentials | Region.Region>(),
    );

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.S3.PresignPutObject(${bucket})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["s3:PutObject"],
              Resource: [Output.interpolate`${bucket.bucketArn}/*`],
            },
          ],
        });
      }
      return Effect.fn(`AWS.S3.PresignPutObject(${bucket.LogicalId})`)(function* (
        request: PresignPutObjectRequest,
      ) {
        const bucketName = yield* BucketName;
        return yield* Presign.presignS3Url({
          method: "PUT",
          bucket: bucketName,
          key: request.key,
          expiresIn: request.expiresIn,
          contentType: request.contentType,
        }).pipe(Effect.provideContext(services));
      });
    });
  }),
);
