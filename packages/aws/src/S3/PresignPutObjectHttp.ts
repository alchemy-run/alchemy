import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding, presign } from "./BindingHttp.ts";
import { PresignPutObject } from "./PresignPutObject.ts";

export const PresignPutObjectHttp = Layer.effect(
  PresignPutObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.PresignPutObject",
    operation: presign(S3.putObject),
    actions: [
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:PutObjectAcl",
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
    ],
  }),
);
