import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

export class PutObject extends Binding.Service<
  PutObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRequest,
    ) => Effect.Effect<S3.PutObjectOutput, S3.PutObjectError>
  >
>()("AWS.S3.PutObject") {}

export const PutObjectLive = Layer.effect(
  PutObject,
  Effect.gen(function* () {
    const bind = yield* PutObjectPolicy;
    const putObject = yield* S3.putObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* bind(bucket);
      return Effect.fn(function* (request: PutObjectRequest) {
        return yield* putObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class PutObjectPolicy extends Binding.Policy<
  PutObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.PutObject") {}

export const PutObjectPolicyLive = PutObjectPolicy.layer.succeed(
  Effect.fn(function* (ctx, bucket) {
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "PutObject",
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutObjectPolicy does not support runtime '${ctx.type}'`,
      );
    }
  }),
);
