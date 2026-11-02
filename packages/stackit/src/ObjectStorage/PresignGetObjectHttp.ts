import * as Presign from "@distilled.cloud/aws/Presign";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { PresignGetObject, type PresignGetObjectRequest } from "./PresignGetObject.ts";

/**
 * SigV4 implementation of {@link PresignGetObject}.
 *
 * @layer
 * @provides Stackit.ObjectStorage.PresignGetObject
 */
export const PresignGetObjectHttp = Layer.effect(
  PresignGetObject,
  makeBucketHttpBinding({
    tag: "Stackit.ObjectStorage.PresignGetObject",
    level: "Read",
    makeClient:
      ({ bucketName, withS3 }) =>
      (request: PresignGetObjectRequest) =>
        bucketName.pipe(
          Effect.flatMap((bucket) =>
            withS3(
              Presign.presignS3Url({
                method: "GET",
                bucket,
                key: request.key,
                versionId: request.versionId,
                expiresIn: request.expiresIn,
                responseContentType: request.contentType,
              }),
            ),
          ),
        ),
  }),
);
