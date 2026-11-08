import * as Presign from "@distilled.cloud/aws/Presign";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding, presign } from "./BindingHttp.ts";
import { PresignPutObject, type PresignPutObjectRequest } from "./PresignPutObject.ts";

export const PresignPutObjectHttp = Layer.effect(
  PresignPutObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.PresignPutObject",
    operation: presign(({ expiresIn, ...request }: PresignPutObjectRequest & { Bucket: string }) =>
      Presign.presignRequest(S3.putObject, request, { expiresIn }),
    ),
    // `Tagging`, `ACL`/`Grant*` and the Object Lock fields each need their own action.
    actions: [
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:PutObjectAcl",
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
    ],
  }),
);
