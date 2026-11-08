import type * as Presign from "@distilled.cloud/aws/Presign";
import type * as S3 from "@distilled.cloud/aws/s3";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";

export interface PresignPutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket" | "Body"> {
  /**
   * Number of seconds the URL remains valid.
   * @default 900
   */
  expiresIn?: number;
}

/**
 * Mint presigned upload (PUT) URLs for objects in a {@link Bucket}.
 *
 * Takes the same input as `AWS.S3.PutObject`, without `Bucket` and `Body`.
 * Every field is signed: `x-amz-*` fields (`Metadata`, `Tagging`,
 * `StorageClass`, ...) go into the URL, the others (`ContentType`,
 * `ContentLength`, `IfNoneMatch`, `ContentMD5`, checksums, server-side
 * encryption, ...) come back in `headers`, which the uploader must send as
 * they are or S3 rejects the upload.
 *
 * Presigning is a pure SigV4 computation performed client-side with the
 * Function's own credentials — no S3 API call is made. Because the URL
 * inherits the signer's IAM permissions, the binding grants the host
 * Function `s3:PutObject` on the bucket's objects, plus what the optional
 * fields need: `s3:PutObjectTagging` (`Tagging`), `s3:PutObjectAcl` (`ACL`,
 * `Grant*`), `s3:PutObjectRetention` (`ObjectLockMode`,
 * `ObjectLockRetainUntilDate`) and `s3:PutObjectLegalHold`
 * (`ObjectLockLegalHoldStatus`). A KMS key named by `SSEKMSKeyId` needs a
 * grant of its own.
 *
 * ### Presigning Upload URLs
 * **Example:** Mint a presigned PUT URL
 * ```typescript
 * const presignPutObject = yield* S3.PresignPutObject(bucket);
 * const { url } = yield* presignPutObject({ Key: "uploads/avatar.png" });
 * // hand `url` to a browser — it can PUT the object without AWS credentials
 * ```
 *
 * **Example:** Pin the type and size, and refuse to overwrite
 * ```typescript
 * const upload = yield* presignPutObject({
 *   Key: "uploads/avatar.png",
 *   ContentType: "image/png",
 *   ContentLength: size, // the size the client declared, checked against your limit
 *   IfNoneMatch: "*", // fails if the key already exists
 *   expiresIn: 300, // valid for 5 minutes
 * });
 * // the browser sends: fetch(upload.url, { method: "PUT", headers: upload.headers, body })
 * ```
 *
 * @binding
 */
export interface PresignPutObject extends Binding.Service<
  PresignPutObject,
  "AWS.S3.PresignPutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PresignPutObjectRequest,
    ) => Effect.Effect<Presign.PresignedRequest, Presign.PresignRequestError>
  >
> {}

export const PresignPutObject = Binding.Service<PresignPutObject>("AWS.S3.PresignPutObject");
