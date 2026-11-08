import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding, presign } from "./BindingHttp.ts";
import { PresignGetObject } from "./PresignGetObject.ts";

export const PresignGetObjectHttp = Layer.effect(
  PresignGetObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.PresignGetObject",
    operation: presign(S3.getObject),
    actions: ["s3:GetObject", "s3:GetObjectVersion"],
  }),
);
