import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface HeadObjectRequest extends Omit<
  S3.HeadObjectRequest,
  "Bucket"
> {}

export class HeadObject extends Binding.Service<
  HeadObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: HeadObjectRequest,
    ) => Effect.Effect<S3.HeadObjectOutput, S3.HeadObjectError>
  >
>()("AWS.S3.HeadObject") {}

export const HeadObjectLive = Layer.effect(
  HeadObject,
  Effect.gen(function* () {
    const Policy = yield* HeadObjectPolicy;
    const headObject = yield* S3.headObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: HeadObjectRequest) {
        return yield* headObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class HeadObjectPolicy extends Binding.Policy<
  HeadObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.HeadObject") {}

export const HeadObjectPolicyLive = Layer.effect(
  HeadObjectPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (bucket: Bucket) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "HeadObject",
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [Output.interpolate`${bucket.bucketArn}/*`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `HeadObjectPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
