import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import type { Bucket } from "../AWS/S3/Bucket.ts";
import type {
  BucketNotification,
  NotificationsProps,
} from "../AWS/S3/BucketNotifications.ts";
import * as S3 from "../AWS/S3/index.ts";
import type { S3EventType } from "../AWS/S3/S3Event.ts";
import * as SQS from "../AWS/SQS/index.ts";
import { ProcessRuntime } from "./Runtime.ts";

export const S3BucketEventSource = Layer.effect(
  S3.BucketEventSource,
  Effect.gen(function* () {
    const Queue = yield* SQS.Queue;
    const Policy = yield* S3BucketEventSourcePolicy;

    return Effect.fn(function* <
      Events extends S3EventType[],
      StreamReq = never,
      Req = never,
    >(
      bucket: Bucket,
      props: NotificationsProps<Events>,
      process: (
        stream: Stream.Stream<BucketNotification, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const queue = yield* Queue(`${bucket.LogicalId}-BucketEvents`);

      yield* Policy({
        bucket,
        queue,
        events: props.events,
      });

      yield* SQS.messages(queue).subscribe((stream) =>
        stream.pipe(
          Stream.flatMap((record) =>
            Stream.fromArray((JSON.parse(record.body) as S3.S3Event).Records),
          ),
          Stream.map((event) => ({
            type: event.eventName as S3.S3EventType,
            bucket: event.s3.bucket.name,
            key: event.s3.object.key,
            size: event.s3.object.size,
            eTag: event.s3.object.eTag,
          })),
          process,
        ),
      );
    }) as S3.BucketEventSourceService;
  }),
);

export class S3BucketEventSourcePolicy extends ServiceMap.Service<
  S3BucketEventSourcePolicy,
  (props: {
    bucket: S3.Bucket;
    queue: SQS.Queue;
    events?: S3.S3EventType[];
  }) => Effect.Effect<void>
>()("AWS.S3.S3BucketEventSourcePolicy") {}

export const S3BucketEventSourcePolicyLive = Layer.effect(
  S3BucketEventSourcePolicy,
  Effect.gen(function* () {
    // this should only be run in a process-oriented runtime like a EC2 instance or a Kubernetes pod etc.
    yield* ProcessRuntime;

    return ({ bucket, queue, events: Events = ["s3:ObjectCreated:*"] }) =>
      Effect.all([
        queue.bind({
          policyStatements: [
            {
              Sid: `AllowS3EventsFrom${bucket.LogicalId}`,
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [queue.queueArn],
              Condition: {
                ArnEquals: {
                  "aws:SourceArn": bucket.bucketArn,
                },
              },
            },
          ],
        }),
        bucket.bind({
          notificationConfiguration: {
            QueueConfigurations: [
              {
                QueueArn: queue.queueArn,
                Events,
              },
            ],
          },
        }),
      ]);
  }),
);
