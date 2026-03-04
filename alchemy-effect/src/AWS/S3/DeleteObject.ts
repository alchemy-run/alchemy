import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface DeleteObjectRequest extends Omit<
  S3.DeleteObjectRequest,
  "Bucket"
> {}

export class DeleteObject extends Binding.Service<
  DeleteObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: DeleteObjectRequest,
    ) => Effect.Effect<S3.DeleteObjectOutput, S3.DeleteObjectError>
  >
>()("AWS.S3.DeleteObject") {}

export const DeleteObjectLive = Layer.effect(
  DeleteObject,
  Effect.gen(function* () {
    const Policy = yield* DeleteObjectPolicy;
    const deleteObject = yield* S3.deleteObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: DeleteObjectRequest) {
        return yield* deleteObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class DeleteObjectPolicy extends Binding.Policy<
  DeleteObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.DeleteObject") {}

export const DeleteObjectPolicyLive = DeleteObjectPolicy.layer.succeed(
  Effect.fn(function* (host, bucket) {
    if (Lambda.isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.S3.DeleteObject(${bucket}))`({
        policyStatements: [
          {
            Sid: "DeleteObject",
            Effect: "Allow",
            Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DeleteObjectPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
