import * as Presign from "@distilled.cloud/aws/Presign";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding, presign } from "./BindingHttp.ts";
import { PresignGetObject, type PresignGetObjectRequest } from "./PresignGetObject.ts";

export const PresignGetObjectHttp = Layer.effect(
  PresignGetObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.PresignGetObject",
    operation: presign(({ expiresIn, ...request }: PresignGetObjectRequest & { Bucket: string }) =>
      Presign.presignRequest(S3.getObject, request, { expiresIn }),
    ),
    actions: ["s3:GetObject", "s3:GetObjectVersion"],
  }),
);
