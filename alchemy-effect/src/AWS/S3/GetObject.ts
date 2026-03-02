import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

export class GetObject extends Binding.Service<
  GetObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<S3.GetObjectOutput, S3.GetObjectError>
  >
>()("AWS.S3.GetObject") {}

export const GetObjectLive = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const Policy = yield* GetObjectPolicy;
    const getObject = yield* S3.getObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: GetObjectRequest) {
        return yield* getObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class GetObjectPolicy extends Binding.Policy<
  GetObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.GetObject") {}

export const GetObjectPolicyLive = Layer.effect(
  GetObjectPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (bucket: Bucket) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "GetObject",
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:GetObjectVersion"],
              Resource: [Output.interpolate`${bucket.bucketArn}/*`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `GetObjectPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
