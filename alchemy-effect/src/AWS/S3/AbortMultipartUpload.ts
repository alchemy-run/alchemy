import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface AbortMultipartUploadRequest extends Omit<
  S3.AbortMultipartUploadRequest,
  "Bucket"
> {}

export class AbortMultipartUpload extends Binding.Service<
  AbortMultipartUpload,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: AbortMultipartUploadRequest,
    ) => Effect.Effect<
      S3.AbortMultipartUploadOutput,
      S3.AbortMultipartUploadError
    >
  >
>()("AWS.S3.AbortMultipartUpload") {}

export const AbortMultipartUploadLive = Layer.effect(
  AbortMultipartUpload,
  Effect.gen(function* () {
    const Policy = yield* AbortMultipartUploadPolicy;
    const abortMultipartUpload = yield* S3.abortMultipartUpload;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: AbortMultipartUploadRequest) {
        return yield* abortMultipartUpload({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class AbortMultipartUploadPolicy extends Binding.Policy<
  AbortMultipartUploadPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.AbortMultipartUpload") {}

export const AbortMultipartUploadPolicyLive =
  AbortMultipartUploadPolicy.layer.succeed(
    Effect.fn(function* (ctx, bucket: Bucket) {
      if (Lambda.isFunction(ctx)) {
        yield* ctx.bind({
          policyStatements: [
            {
              Sid: "AbortMultipartUpload",
              Effect: "Allow",
              Action: ["s3:AbortMultipartUpload"],
              Resource: [Output.interpolate`${bucket.bucketArn}/*`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `AbortMultipartUploadPolicy does not support runtime '${ctx.type}'`,
        );
      }
    }),
  );
