import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { createPhysicalName } from "../../physical-name.ts";
import { createInternalTags, diffTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Stream, type StreamProps, type ShardLevelMetric } from "./stream.ts";
import { Region } from "distilled-aws/Region";
import * as kinesis from "distilled-aws/kinesis";

const waitForStreamActive = (streamName: string) =>
  Effect.gen(function* () {
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
        Schedule.intersect(Schedule.recurs(60)),
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
        Schedule.intersect(Schedule.recurs(60)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

export const streamProvider = () =>
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
        diff: Effect.fn(function* ({ id, news, olds }) {
          const oldStreamName = yield* createStreamName(id, olds);
          const newStreamName = yield* createStreamName(id, news);
          if (oldStreamName !== newStreamName) {
            return { action: "replace" } as const;
          }
          // Stream mode changes, shard count changes, retention period changes, encryption changes
          // can all be done via update
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const streamName = yield* createStreamName(id, news);
          const internalTags = yield* createInternalTags(id);
          const allTags = { ...internalTags, ...news.tags };

          yield* kinesis
            .createStream({
              StreamName: streamName,
              ShardCount: news.streamMode === "PROVISIONED" ? news.shardCount : undefined,
              StreamModeDetails: getStreamMode(news),
              Tags: allTags,
            })
            .pipe(
              Effect.catchTag("ResourceInUseException", () => Effect.void),
              Effect.retry({
                while: (e) => e.name === "LimitExceededException",
                schedule: Schedule.exponential(1000),
              }),
            );

          yield* session.note(`Creating stream ${streamName}...`);
          yield* waitForStreamActive(streamName);

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

          const streamArn = `arn:aws:kinesis:${region}:${accountId}:stream/${streamName}` as const;
          yield* session.note(streamArn);

          return {
            streamName,
            streamArn,
            streamStatus: "ACTIVE" as const,
          };
        }),
        update: Effect.fn(function* ({ news, olds, output, session }) {
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
          if (newMode === "PROVISIONED" && news.shardCount && news.shardCount !== olds.shardCount) {
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
            yield* session.note(`Updated retention period to ${newRetention} hours`);
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
          } else if (oldEncryption && newEncryption && olds.kmsKeyId !== news.kmsKeyId) {
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
          const metricsToEnable = (news.shardLevelMetrics ?? []).filter(m => !oldMetrics.has(m));
          const metricsToDisable = (olds.shardLevelMetrics ?? []).filter(m => !newMetrics.has(m));

          if (metricsToDisable.length > 0) {
            yield* kinesis.disableEnhancedMonitoring({
              StreamName: streamName,
              ShardLevelMetrics: metricsToDisable,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(`Disabled metrics: ${metricsToDisable.join(", ")}`);
          }

          if (metricsToEnable.length > 0) {
            yield* kinesis.enableEnhancedMonitoring({
              StreamName: streamName,
              ShardLevelMetrics: metricsToEnable,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(`Enabled metrics: ${metricsToEnable.join(", ")}`);
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
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));

          yield* waitForStreamDeleted(input.output.streamName);
        }),
      };
    }),
  );
