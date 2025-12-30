import * as Effect from "effect/Effect";

import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import { toEnvKey } from "../../env.ts";
import { declare, type To } from "../../policy.ts";
import { Function } from "../lambda/function.ts";
import { S3Client } from "./client.ts";
import { Bucket } from "./bucket.ts";

export interface DeleteObject<B = Bucket> extends Capability<
  "AWS.S3.DeleteObject",
  B
> {}

export const DeleteObject = Binding<
  <B extends Bucket>(bucket: B) => Binding<Function, DeleteObject<To<B>>>
>(Function, "AWS.S3.DeleteObject");

export interface DeleteObjectOptions {
  key: string;
  versionId?: string;
}

export const deleteObject = <B extends Bucket>(
  bucket: B,
  options: DeleteObjectOptions,
) =>
  Effect.gen(function* () {
    yield* declare<DeleteObject<To<B>>>();
    const s3 = yield* S3Client;
    const bucketName = process.env[toEnvKey(bucket.id, "BUCKET_NAME")]!;

    return yield* s3.deleteObject({
      Bucket: bucketName,
      Key: options.key,
      VersionId: options.versionId,
    });
  });

export const deleteObjectFromLambdaFunction = () =>
  DeleteObject.provider.succeed({
    attach: ({ source: bucket }) => ({
      env: {
        [toEnvKey(bucket.id, "BUCKET_NAME")]: bucket.attr.bucketName,
        [toEnvKey(bucket.id, "BUCKET_ARN")]: bucket.attr.bucketArn,
      },
      policyStatements: [
        {
          Sid: "DeleteObject",
          Effect: "Allow",
          Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
          Resource: [`${bucket.attr.bucketArn}/*`],
        },
      ],
    }),
  });
