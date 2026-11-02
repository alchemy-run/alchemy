import * as Presign from "@distilled.cloud/aws/Presign";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { PresignPutObject, type PresignPutObjectRequest } from "./PresignPutObject.ts";

/**
 * SigV4 implementation of {@link PresignPutObject}.
 *
 * @layer
 * @provides Stackit.ObjectStorage.PresignPutObject
 */
export const PresignPutObjectHttp = Layer.effect(
  PresignPutObject,
  makeBucketHttpBinding({
    tag: "Stackit.ObjectStorage.PresignPutObject",
    level: "Write",
    makeClient:
      ({ bucketName, withS3 }) =>
      (request: PresignPutObjectRequest) =>
        bucketName.pipe(
          Effect.flatMap((bucket) =>
            withS3(
              Presign.presignS3Url({
                method: "PUT",
                bucket,
                key: request.key,
                expiresIn: request.expiresIn,
                contentType: request.contentType,
              }),
            ),
          ),
        ),
  }),
);
