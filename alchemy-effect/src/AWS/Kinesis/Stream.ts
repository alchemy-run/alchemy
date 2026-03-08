// required to avoid this error in consumers: "The inferred type of 'Messages' cannot be named without a reference to '../../distilled-aws/node_modules/@types/aws-lambda'. This is likely not portable. A type annotation is necessary.ts(2742)"
export type * as lambda from "aws-lambda";

import type * as lambda from "aws-lambda";
import { Region } from "distilled-aws/Region";
import * as kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { Account, type AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type StreamRecord = lambda.KinesisStreamRecord;

export type StreamEvent = lambda.KinesisStreamEvent;

export type StreamName = string;
export type StreamArn =
  `arn:aws:kinesis:${RegionID}:${AccountID}:stream/${StreamName}`;

export interface Stream extends Resource<
  "AWS.Kinesis.Stream",
  StreamProps,
  {
    streamName: StreamName;
    streamArn: StreamArn;
    streamStatus: StreamStatus;
  }
> {}

export const Stream = Resource<Stream>("AWS.Kinesis.Stream");

export type StreamStatus = "CREATING" | "DELETING" | "ACTIVE" | "UPDATING";

export type StreamMode = "PROVISIONED" | "ON_DEMAND";

export type StreamProps = {
  /**
   * Name of the stream.
   * @default ${app}-${stage}-${id}
   */
  streamName?: string;
  /**
   * The capacity mode of the data stream.
   * - PROVISIONED: You specify the number of shards for the data stream.
   * - ON_DEMAND: AWS manages the shards for the data stream.
   * @default "ON_DEMAND"
   */
  streamMode?: StreamMode;
  /**
   * The number of shards that the stream will use when in PROVISIONED mode.
   * Required when streamMode is "PROVISIONED".
   * @default undefined (required for PROVISIONED mode)
   */
  shardCount?: number;
  /**
   * The number of hours for the data records that are stored in shards to remain accessible.
   * The retention period ranges from 24 hours (1 day) to 8760 hours (365 days).
   * @default 24
   */
  retentionPeriodHours?: number;
  /**
   * If set to true, server-side encryption is enabled on the stream.
   * Uses the AWS managed CMK for Kinesis (alias/aws/kinesis).
   * @default false
   */
  encryption?: boolean;
  /**
   * The GUID for the customer-managed AWS KMS key to use for encryption.
   * Only relevant when encryption is enabled.
   * If not specified, AWS managed CMK for Kinesis is used.
   */
  kmsKeyId?: string;
  /**
   * A list of shard-level CloudWatch metrics to enable for the stream.
   * Valid values: IncomingBytes, IncomingRecords, OutgoingBytes, OutgoingRecords, WriteProvisionedThroughputExceeded, ReadProvisionedThroughputExceeded, IteratorAgeMilliseconds, ALL
   */
  shardLevelMetrics?: ShardLevelMetric[];
  /**
   * Tags to associate with the stream.
   */
  tags?: Record<string, string>;
};

export type ShardLevelMetric =
  | "IncomingBytes"
  | "IncomingRecords"
  | "OutgoingBytes"
  | "OutgoingRecords"
  | "WriteProvisionedThroughputExceeded"
  | "ReadProvisionedThroughputExceeded"
  | "IteratorAgeMilliseconds"
  | "ALL";

export const StreamProvider = () =>
  Stream.provider.effect(
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createStreamName = (
        id: string,
        props: {
          streamName?: string | undefined;
        },
      ) =>
        Effect.gen(function* () {
          if (props.streamName) {
            return props.streamName;
          }
          return yield* createPhysicalName({
            id,
            maxLength: 128, // Kinesis stream names can be up to 128 characters
          });
        });

      const getStreamMode = (props: StreamProps): kinesis.StreamModeDetails => {
        const mode = props.streamMode ?? "ON_DEMAND";
        return { StreamMode: mode };
      };

      return {
        stables: ["streamName", "streamArn"],
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          const oldStreamName = yield* createStreamName(id, olds);
          const newStreamName = yield* createStreamName(id, news);
          if (oldStreamName !== newStreamName) {
            return { action: "replace" } as const;
          }
          // Stream mode changes, shard count changes, retention period changes, encryption changes
          // can all be done via update
        }),
        create: Effect.fn(function* ({ id, news = {}, session }) {
          const streamName = yield* createStreamName(id, news);
          const internalTags = yield* createInternalTags(id);
          const allTags = { ...internalTags, ...news.tags };

          yield* kinesis
            .createStream({
              StreamName: streamName,
              ShardCount:
                news.streamMode === "PROVISIONED" ? news.shardCount : undefined,
              StreamModeDetails: getStreamMode(news),
              Tags: allTags,
            })
            .pipe(
              Effect.catchTag("ResourceInUseException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "LimitExceededException",
                schedule: Schedule.exponential(1000),
              }),
            );

          yield* session.note(`Creating stream ${streamName}...`);
          yield* waitForStreamActive(streamName);
          yield* session.note(`Stream ${streamName} created`);

          // Configure encryption if requested
          if (news.encryption) {
            yield* kinesis.startStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: news.kmsKeyId ?? "alias/aws/kinesis",
            });
            yield* waitForStreamActive(streamName);
          }

          // Configure retention period if not default (24 hours)
          if (news.retentionPeriodHours && news.retentionPeriodHours !== 24) {
            if (news.retentionPeriodHours > 24) {
              yield* kinesis.increaseStreamRetentionPeriod({
                StreamName: streamName,
                RetentionPeriodHours: news.retentionPeriodHours,
              });
            } else {
              yield* kinesis.decreaseStreamRetentionPeriod({
                StreamName: streamName,
                RetentionPeriodHours: news.retentionPeriodHours,
              });
            }
            yield* waitForStreamActive(streamName);
          }

          // Enable enhanced shard-level metrics if requested
          if (news.shardLevelMetrics && news.shardLevelMetrics.length > 0) {
            yield* kinesis.enableEnhancedMonitoring({
              StreamName: streamName,
              ShardLevelMetrics: news.shardLevelMetrics,
            });
            yield* waitForStreamActive(streamName);
          }

          const streamArn =
            `arn:aws:kinesis:${region}:${accountId}:stream/${streamName}` as const;
          yield* session.note(streamArn);

          return {
            streamName,
            streamArn,
            streamStatus: "ACTIVE" as const,
          };
        }),
        update: Effect.fn(function* ({
          news = {},
          olds = {},
          output,
          session,
        }) {
          const streamName = output.streamName;

          // Handle stream mode changes
          const oldMode = olds.streamMode ?? "ON_DEMAND";
          const newMode = news.streamMode ?? "ON_DEMAND";
          if (oldMode !== newMode) {
            yield* kinesis.updateStreamMode({
              StreamARN: output.streamArn,
              StreamModeDetails: getStreamMode(news),
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(`Updated stream mode to ${newMode}`);
          }

          // Handle shard count changes (only for PROVISIONED mode)
          if (
            newMode === "PROVISIONED" &&
            news.shardCount &&
            news.shardCount !== olds.shardCount
          ) {
            yield* kinesis.updateShardCount({
              StreamName: streamName,
              TargetShardCount: news.shardCount,
              ScalingType: "UNIFORM_SCALING",
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(`Updated shard count to ${news.shardCount}`);
          }

          // Handle retention period changes
          const oldRetention = olds.retentionPeriodHours ?? 24;
          const newRetention = news.retentionPeriodHours ?? 24;
          if (oldRetention !== newRetention) {
            if (newRetention > oldRetention) {
              yield* kinesis.increaseStreamRetentionPeriod({
                StreamName: streamName,
                RetentionPeriodHours: newRetention,
              });
            } else {
              yield* kinesis.decreaseStreamRetentionPeriod({
                StreamName: streamName,
                RetentionPeriodHours: newRetention,
              });
            }
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Updated retention period to ${newRetention} hours`,
            );
          }

          // Handle encryption changes
          const oldEncryption = olds.encryption ?? false;
          const newEncryption = news.encryption ?? false;
          if (!oldEncryption && newEncryption) {
            yield* kinesis.startStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: news.kmsKeyId ?? "alias/aws/kinesis",
            });
            yield* waitForStreamActive(streamName);
            yield* session.note("Enabled encryption");
          } else if (oldEncryption && !newEncryption) {
            yield* kinesis.stopStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: olds.kmsKeyId ?? "alias/aws/kinesis",
            });
            yield* waitForStreamActive(streamName);
            yield* session.note("Disabled encryption");
          } else if (
            oldEncryption &&
            newEncryption &&
            olds.kmsKeyId !== news.kmsKeyId
          ) {
            // Change KMS key - need to stop and restart encryption
            yield* kinesis.stopStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: olds.kmsKeyId ?? "alias/aws/kinesis",
            });
            yield* waitForStreamActive(streamName);
            yield* kinesis.startStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: news.kmsKeyId ?? "alias/aws/kinesis",
            });
            yield* waitForStreamActive(streamName);
            yield* session.note("Updated KMS key");
          }

          // Handle shard-level metrics changes
          const oldMetrics = new Set(olds.shardLevelMetrics ?? []);
          const newMetrics = new Set(news.shardLevelMetrics ?? []);
          const metricsToEnable = (news.shardLevelMetrics ?? []).filter(
            (m) => !oldMetrics.has(m),
          );
          const metricsToDisable = (olds.shardLevelMetrics ?? []).filter(
            (m) => !newMetrics.has(m),
          );

          if (metricsToDisable.length > 0) {
            yield* kinesis.disableEnhancedMonitoring({
              StreamName: streamName,
              ShardLevelMetrics: metricsToDisable,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Disabled metrics: ${metricsToDisable.join(", ")}`,
            );
          }

          if (metricsToEnable.length > 0) {
            yield* kinesis.enableEnhancedMonitoring({
              StreamName: streamName,
              ShardLevelMetrics: metricsToEnable,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Enabled metrics: ${metricsToEnable.join(", ")}`,
            );
          }

          // Handle tag changes
          const internalTags = yield* createInternalTags(output.streamName);
          const oldTags = { ...internalTags, ...olds.tags };
          const newTags = { ...internalTags, ...news.tags };
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* kinesis.removeTagsFromStream({
              StreamName: streamName,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            const tagsToAdd: Record<string, string> = {};
            for (const { Key, Value } of upsert) {
              tagsToAdd[Key] = Value;
            }
            yield* kinesis.addTagsToStream({
              StreamName: streamName,
              Tags: tagsToAdd,
            });
          }

          yield* session.note(output.streamArn);
          return output;
        }),
        delete: Effect.fn(function* (input) {
          yield* kinesis
            .deleteStream({
              StreamName: input.output.streamName,
              EnforceConsumerDeletion: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* waitForStreamDeleted(input.output.streamName);
        }),
      };
    }),
  );

const waitForStreamActive = (streamName: string) =>
  Effect.gen(function* () {
    yield* Effect.sleep("2 seconds");
    const { StreamDescriptionSummary } = yield* kinesis.describeStreamSummary({
      StreamName: streamName,
    });
    if (StreamDescriptionSummary.StreamStatus !== "ACTIVE") {
      return yield* Effect.fail({ _tag: "StreamNotActive" as const });
    }
    return StreamDescriptionSummary;
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "StreamNotActive" ||
        // During stream creation, AWS may return incomplete responses that fail parsing
        e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
  );

const waitForStreamDeleted = (streamName: string) =>
  Effect.gen(function* () {
    yield* kinesis.describeStreamSummary({
      StreamName: streamName,
    });
    return yield* Effect.fail({ _tag: "StreamStillExists" as const });
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "StreamStillExists" ||
        // During stream deletion, AWS may return incomplete responses that fail parsing
        e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
