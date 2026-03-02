import * as S3 from "distilled-aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Bucket } from "./Bucket.ts";

export interface ListObjectsV2Request extends Omit<
  S3.ListObjectsV2Request,
  "Bucket"
> {}

export class ListObjectsV2 extends Binding.Service<
  ListObjectsV2,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: ListObjectsV2Request,
    ) => Effect.Effect<S3.ListObjectsV2Output, S3.ListObjectsV2Error>
  >
>()("AWS.S3.ListObjectsV2") {}

export const ListObjectsV2Live = Layer.effect(
  ListObjectsV2,
  Effect.gen(function* () {
    const Policy = yield* ListObjectsV2Policy;
    const listObjectsV2 = yield* S3.listObjectsV2;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request?: ListObjectsV2Request) {
        return yield* listObjectsV2({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class ListObjectsV2Policy extends Binding.Policy<
  ListObjectsV2Policy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.ListObjectsV2") {}

export const ListObjectsV2PolicyLive = Layer.effect(
  ListObjectsV2Policy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (bucket: Bucket) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "ListObjectsV2",
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: [Output.interpolate`${bucket.bucketArn}`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `ListObjectsV2Policy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
