// @ts-nocheck
import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface CopyObjectRequest extends Omit<
  S3.CopyObjectRequest,
  "Bucket"
> {}

export class CopyObject extends Binding.Service<
  CopyObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CopyObjectRequest,
    ) => Effect.Effect<S3.CopyObjectOutput, S3.CopyObjectError>
  >
>()("AWS.S3.CopyObject") {}

export const CopyObjectLive = Layer.effect(
  CopyObject,
  Effect.gen(function* () {
    const Policy = yield* CopyObjectPolicy;
    const copyObject = yield* S3.copyObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: CopyObjectRequest) {
        return yield* copyObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class CopyObjectPolicy extends Binding.Policy<
  CopyObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.CopyObject") {}

export const CopyObjectPolicyLive = CopyObjectPolicy.layer.succeed(
  Effect.fn(function* (ctx, bucket: Bucket) {
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "CopyObject",
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:GetObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `CopyObjectPolicy does not support runtime '${ctx.type}'`,
      );
    }
  }),
);
