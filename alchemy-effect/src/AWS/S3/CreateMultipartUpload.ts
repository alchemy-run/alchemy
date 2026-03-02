import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CreateMultipartUploadRequest extends Omit<
  S3.CreateMultipartUploadRequest,
  "Bucket"
> {}

export class CreateMultipartUpload extends Binding.Service<
  CreateMultipartUpload,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CreateMultipartUploadRequest,
    ) => Effect.Effect<
      S3.CreateMultipartUploadOutput,
      S3.CreateMultipartUploadError
    >
  >
>()("AWS.S3.CreateMultipartUpload") {}

export const CreateMultipartUploadLive = Layer.effect(
  CreateMultipartUpload,
  Effect.gen(function* () {
    const Policy = yield* CreateMultipartUploadPolicy;
    const createMultipartUpload = yield* S3.createMultipartUpload;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: CreateMultipartUploadRequest) {
        return yield* createMultipartUpload({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class CreateMultipartUploadPolicy extends Binding.Policy<
  CreateMultipartUploadPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.CreateMultipartUpload") {}

export const CreateMultipartUploadPolicyLive = Layer.effect(
  CreateMultipartUploadPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (bucket: Bucket) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "CreateMultipartUpload",
              Effect: "Allow",
              Action: ["s3:PutObject"],
              Resource: [Output.interpolate`${bucket.bucketArn}/*`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `CreateMultipartUploadPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
