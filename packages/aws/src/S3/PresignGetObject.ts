import type * as Presign from "@distilled.cloud/aws/Presign";
import type * as S3 from "@distilled.cloud/aws/s3";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";

export interface PresignGetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {
  /**
   * Number of seconds the URL remains valid.
   * @default 900
   */
  expiresIn?: number;
}

/**
 * Mint presigned download (GET) URLs for objects in a {@link Bucket}.
 *
 * Takes the same input as `AWS.S3.GetObject`, without `Bucket`. Query fields
 * (`VersionId`, `PartNumber`, the `ResponseContent*` overrides) are signed
 * into the URL. Header fields (`Range`, `IfMatch`, SSE-C keys, ...) come
 * back in `headers`, which the downloader must send as they are.
 *
 * Presigning is a pure SigV4 computation performed client-side with the
 * Function's own credentials — no S3 API call is made. Because the URL
 * inherits the signer's IAM permissions, the binding grants `s3:GetObject`
 * and `s3:GetObjectVersion` (`VersionId`) on the bucket's objects to the
 * host Function. See the [S3 presigned URL
 * guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
 *
 * ### Presigning Download URLs
 * **Example:** Mint a presigned GET URL
 * ```typescript
 * const presignGetObject = yield* S3.PresignGetObject(bucket);
 * const { url } = yield* presignGetObject({ Key: "reports/2026.pdf" });
 * // hand `url` to a browser — it can download the object without AWS credentials
 * ```
 *
 * ### Downloading a Specific Version
 * **Example:** Mint a presigned GET URL for an older version
 * ```typescript
 * const { url } = yield* presignGetObject({
 *   Key: "reports/2026.pdf",
 *   VersionId: "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nrjfkd",
 * });
 * // downloads this version even if the key has since been overwritten
 * ```
 *
 * ### Customizing Download URLs
 * **Example:** Keep the original file name
 * ```typescript
 * const { url } = yield* presignGetObject({
 *   Key: "reports/2026.pdf",
 *   ResponseContentType: "application/pdf",
 *   ResponseContentDisposition: 'attachment; filename="Q1 report.pdf"',
 *   expiresIn: 3600, // valid for 1 hour
 * });
 * ```
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
 *
 * @binding
 */
export interface PresignGetObject extends Binding.Service<
  PresignGetObject,
  "AWS.S3.PresignGetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PresignGetObjectRequest,
    ) => Effect.Effect<Presign.PresignedRequest, Presign.PresignRequestError>
  >
> {}

export const PresignGetObject = Binding.Service<PresignGetObject>("AWS.S3.PresignGetObject");
