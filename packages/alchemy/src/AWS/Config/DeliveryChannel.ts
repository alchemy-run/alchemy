import * as config from "@distilled.cloud/aws/config-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface DeliveryChannelProps {
  /**
   * Name of the delivery channel. AWS Config allows exactly one delivery
   * channel per account per region; changing the name replaces it.
   * @default ${app}-${stage}-${id}
   */
  channelName?: string;
  /**
   * Name of the S3 bucket that receives configuration snapshots and history.
   * The bucket must have a policy granting `config.amazonaws.com` write access.
   */
  s3BucketName: string;
  /**
   * S3 key prefix prepended to delivered objects.
   */
  s3KeyPrefix?: string;
  /**
   * ARN of a KMS key used to encrypt delivered objects (SSE-KMS).
   */
  s3KmsKeyArn?: string;
  /**
   * ARN of an Amazon SNS topic to notify on delivery.
   */
  snsTopicArn?: string;
  /**
   * How often AWS Config delivers configuration snapshots.
   */
  deliveryFrequency?:
    | "One_Hour"
    | "Three_Hours"
    | "Six_Hours"
    | "Twelve_Hours"
    | "TwentyFour_Hours";
}

export interface DeliveryChannel extends Resource<
  "AWS.Config.DeliveryChannel",
  DeliveryChannelProps,
  {
    channelName: string;
    s3BucketName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Config delivery channel — the account/region singleton that delivers
 * configuration snapshots and history to an S3 bucket (and optionally an SNS
 * topic).
 *
 * A configuration recorder cannot start recording until a delivery channel
 * exists. The destination S3 bucket must carry a policy authorizing
 * `config.amazonaws.com` to write objects.
 * @resource
 * @section Creating a Delivery Channel
 * @example Deliver snapshots to S3 every six hours
 * ```typescript
 * import * as Config from "alchemy/AWS/Config";
 *
 * const channel = yield* Config.DeliveryChannel("Channel", {
 *   s3BucketName: bucket.bucketName,
 *   deliveryFrequency: "Six_Hours",
 * });
 * ```
 */
export const DeliveryChannel = Resource<DeliveryChannel>(
  "AWS.Config.DeliveryChannel",
);

export const DeliveryChannelProvider = () =>
  Provider.effect(
    DeliveryChannel,
    Effect.gen(function* () {
      const createChannelName = Effect.fn(function* (
        id: string,
        props: { channelName?: string | undefined },
      ) {
        return (
          props.channelName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const observeChannel = (name: string) =>
        config.describeDeliveryChannels({ DeliveryChannelNames: [name] }).pipe(
          Effect.map((r) => r.DeliveryChannels?.[0]),
          Effect.catchTag("NoSuchDeliveryChannelException", () =>
            Effect.succeed(undefined),
          ),
        );

      return DeliveryChannel.Provider.of({
        stables: ["channelName"],
        // A delivery channel is an account/region singleton; enumerate the (at
        // most one) channel present in the region.
        list: () =>
          config.describeDeliveryChannels({}).pipe(
            Effect.map((r) =>
              (r.DeliveryChannels ?? []).flatMap((c) =>
                c.name
                  ? [
                      {
                        channelName: c.name,
                        s3BucketName: c.s3BucketName ?? "",
                      },
                    ]
                  : [],
              ),
            ),
            Effect.catchTag("NoSuchDeliveryChannelException", () =>
              Effect.succeed([]),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.channelName ?? (yield* createChannelName(id, olds ?? {}));
          const channel = yield* observeChannel(name);
          if (!channel) return undefined;
          return {
            channelName: name,
            s3BucketName: channel.s3BucketName ?? "",
          };
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createChannelName(id, olds);
          const newName = yield* createChannelName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name =
            output?.channelName ?? (yield* createChannelName(id, news));
          // putDeliveryChannel is an idempotent upsert. A just-applied S3
          // bucket policy can be transiently invisible, surfacing as
          // InsufficientDeliveryPolicyException — a consistency race, so retry.
          yield* config
            .putDeliveryChannel({
              DeliveryChannel: {
                name,
                s3BucketName: news.s3BucketName,
                s3KeyPrefix: news.s3KeyPrefix,
                s3KmsKeyArn: news.s3KmsKeyArn,
                snsTopicARN: news.snsTopicArn,
                configSnapshotDeliveryProperties: news.deliveryFrequency
                  ? { deliveryFrequency: news.deliveryFrequency }
                  : undefined,
              },
            })
            .pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "InsufficientDeliveryPolicyException" ||
                  e._tag === "NoSuchBucketException",
                schedule: Schedule.fixed(2000).pipe(
                  Schedule.both(Schedule.recurs(15)),
                ),
              }),
            );
          yield* session.note(name);
          return { channelName: name, s3BucketName: news.s3BucketName };
        }),
        delete: Effect.fn(function* ({ output }) {
          // The delivery channel can only be deleted once the recorder is
          // stopped; a running recorder surfaces
          // LastDeliveryChannelDeleteFailedException. Retry briefly to ride out
          // the recorder-stop that happens concurrently in teardown.
          yield* config
            .deleteDeliveryChannel({ DeliveryChannelName: output.channelName })
            .pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "LastDeliveryChannelDeleteFailedException",
                schedule: Schedule.fixed(2000).pipe(
                  Schedule.both(Schedule.recurs(10)),
                ),
              }),
              Effect.catchTag(
                "NoSuchDeliveryChannelException",
                () => Effect.void,
              ),
              Effect.catchTag(
                "LastDeliveryChannelDeleteFailedException",
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
