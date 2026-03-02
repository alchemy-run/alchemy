import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "../S3/Bucket.ts";
import * as S3 from "../S3/index.ts";
import * as Lambda from "./index.ts";

export const BucketEventSource = Layer.effect(
  S3.BucketEventSource,
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const func = yield* Lambda.Function.ExecutionContext;

    const Policy = yield* BucketEventSourcePolicy;

    return Effect.fn(function* <
      Events extends S3.S3EventType[],
      StreamReq = never,
      Req = never,
    >(
      bucket: Bucket,
      props: S3.NotificationsProps<Events>,
      process: (
        stream: Stream.Stream<S3.BucketNotification, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      // this adds it to the Lambda Function's environment variables
      const BucketName = yield* bucket.bucketName;

      yield* Policy(bucket, props);

      yield* func.listen(
        Effect.gen(function* () {
          // this accesses it
          const bucketName = yield* BucketName;
          return (event: any) => {
            if (isS3Event(event)) {
              const events = event.Records.filter(
                (record) => record.s3.bucket.name === bucketName,
              );
              if (events.length > 0) {
                return process(
                  Stream.fromArray(
                    events.map((record: lambda.S3EventRecord) => ({
                      type: record.eventName as S3.S3EventType,
                      bucket: record.s3.bucket.name,
                      key: record.s3.object.key,
                      size: record.s3.object.size,
                      eTag: record.s3.object.eTag,
                    })),
                  ),
                  // TODO(sam): don't die?
                ).pipe(Effect.orDie);
              }
            }
          };
        }),
      );
    }) as S3.BucketEventSourceService;
  }),
);

const isS3Event = (event: any): event is lambda.S3Event =>
  Array.isArray(event.Records) &&
  event.Records.some((record: any) => record.s3);

export class BucketEventSourcePolicy extends Binding.Policy<
  BucketEventSourcePolicy,
  (
    bucket: S3.Bucket,
    props: S3.NotificationsProps<S3.S3EventType[]>,
  ) => Effect.Effect<void>
>()("AWS.S3.BucketEventSourcePermissions") {}

export const BucketEventSourcePolicyLive = BucketEventSourcePolicy.layer.effect(
  Effect.gen(function* () {
    const LambdaPermission = yield* Lambda.Permission;

    return Effect.fn(function* (
      ctx,
      bucket: S3.Bucket,
      {
        events: Events = ["s3:ObjectCreated:*"],
      }: {
        events?: S3.S3EventType[];
      } = {},
    ) {
      if (Lambda.isFunction(ctx)) {
        yield* LambdaPermission("Permission", {
          action: "lambda.InvokeFunction",
          functionName: ctx.functionName,
          principal: "s3.amazonaws.com",
          sourceArn: bucket.bucketArn,
        });
        yield* bucket.bind({
          notificationConfiguration: {
            LambdaFunctionConfigurations: [
              {
                LambdaFunctionArn: ctx.functionArn,
                Events,
              },
            ],
          },
        });
      } else {
        return yield* Effect.die(
          new Error(
            `BucketEventSourcePolicy does not support runtime '${ctx.type}'`,
          ),
        );
      }
    });
  }),
);
