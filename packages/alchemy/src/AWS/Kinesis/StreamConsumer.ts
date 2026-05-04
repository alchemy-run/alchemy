import * as kinesis from "@distilled.cloud/aws/kinesis";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { StreamArn } from "./Stream.ts";

export type ConsumerName = string;

export type ConsumerArn = string;

export type ConsumerStatus = "CREATING" | "DELETING" | "ACTIVE";

export interface StreamConsumerProps {
  /**
   * ARN of the stream that owns the consumer.
   */
  streamArn: Input<StreamArn>;
  /**
   * Name of the stream consumer.
   * @default ${app}-${stage}-${id}
   */
  consumerName?: string;
  /**
   * Tags to associate with the consumer.
   */
  tags?: Record<string, string>;
}

export interface StreamConsumer extends Resource<
  "AWS.Kinesis.StreamConsumer",
  StreamConsumerProps,
  {
    consumerName: ConsumerName;
    consumerArn: ConsumerArn;
    consumerStatus: ConsumerStatus;
    streamArn: StreamArn;
    consumerCreationTimestamp: Date;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A registered Kinesis enhanced fan-out consumer.
 *
 * `StreamConsumer` is the canonical lifecycle resource for
 * `RegisterStreamConsumer` / `DeregisterStreamConsumer`.
 *
 * @section Creating Consumers
 * @example Register a Consumer
 * ```typescript
 * const consumer = yield* StreamConsumer("AnalyticsConsumer", {
 *   streamArn: stream.streamArn,
 * });
 * ```
 */
export const StreamConsumer = Resource<StreamConsumer>(
  "AWS.Kinesis.StreamConsumer",
);

const createConsumerName = (
  id: string,
  props: {
    consumerName?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    if (props.consumerName) {
      return props.consumerName;
    }
    return yield* createPhysicalName({
      id,
      maxLength: 128,
    });
  });

const toTagRecord = (
  tags: Array<{ Key: string; Value?: string }> | undefined,
) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = ({
  description,
  tags,
}: {
  description: kinesis.ConsumerDescription;
  tags: Record<string, string>;
}): StreamConsumer["Attributes"] => ({
  consumerName: description.ConsumerName,
  consumerArn: description.ConsumerARN,
  consumerStatus: description.ConsumerStatus as ConsumerStatus,
  streamArn: description.StreamARN as StreamArn,
  consumerCreationTimestamp: description.ConsumerCreationTimestamp,
  tags,
});

const readConsumer = Effect.fn(function* ({
  streamArn,
  consumerName,
  consumerArn,
}: {
  streamArn?: string;
  consumerName?: string;
  consumerArn?: string;
}) {
  const response = yield* kinesis
    .describeStreamConsumer({
      StreamARN: streamArn,
      ConsumerName: consumerName,
      ConsumerARN: consumerArn,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  if (!response) {
    return undefined;
  }

  const description = response.ConsumerDescription;
  const tagsResponse = yield* kinesis.listTagsForResource({
    ResourceARN: description.ConsumerARN,
  });

  return toAttrs({
    description,
    tags: toTagRecord(tagsResponse.Tags),
  });
});

// Kinesis tells us "in use" via ResourceInUseException, but the consumer
// registry is eventually consistent — describeStreamConsumer can briefly
// return ResourceNotFoundException for a consumer the registry just
// confirmed exists. Poll up to ~10s before giving up.
class ConsumerRegistryNotConsistent extends Data.TaggedError(
  "ConsumerRegistryNotConsistent",
)<{ consumerName: string }> {}

const adoptExistingConsumer = Effect.fn(function* (
  streamArn: string,
  consumerName: string,
) {
  return yield* Effect.gen(function* () {
    const state = yield* readConsumer({
      streamArn,
      consumerName,
    });

    if (!state) {
      return yield* new ConsumerRegistryNotConsistent({ consumerName });
    }

    return state;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ConsumerRegistryNotConsistent",
      schedule: Schedule.exponential(250).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
    Effect.catchTag("ConsumerRegistryNotConsistent", () =>
      Effect.fail(
        new Error(
          `consumer ${consumerName} exists but could not be read after ` +
            `~10s of registry-consistency retries`,
        ),
      ),
    ),
  );
});

const waitForConsumerStatus = (
  consumerArn: string,
  expectedStatus: ConsumerStatus,
) =>
  Effect.gen(function* () {
    yield* Effect.sleep("2 seconds");
    const response = yield* kinesis.describeStreamConsumer({
      ConsumerARN: consumerArn,
    });
    if (response.ConsumerDescription.ConsumerStatus !== expectedStatus) {
      return yield* Effect.fail({ _tag: "ConsumerStatusNotReady" as const });
    }
    return response.ConsumerDescription;
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "ConsumerStatusNotReady" || e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
  );

const waitForConsumerDeleted = (consumerArn: string) =>
  Effect.gen(function* () {
    yield* kinesis.describeStreamConsumer({
      ConsumerARN: consumerArn,
    });
    return yield* Effect.fail({ _tag: "ConsumerStillExists" as const });
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "ConsumerStillExists" || e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

export const StreamConsumerProvider = () =>
  Provider.succeed(StreamConsumer, {
    stables: ["consumerArn", "consumerName"],
    read: Effect.fn(function* ({ id, olds, output }) {
      const consumerName =
        output?.consumerName ?? (yield* createConsumerName(id, olds ?? {}));
      const state = yield* readConsumer({
        streamArn: olds.streamArn as string | undefined,
        consumerName,
        consumerArn: output?.consumerArn,
      });
      if (!state) return undefined;
      return (yield* hasAlchemyTags(id, state.tags as Tags))
        ? state
        : Unowned(state);
    }),
    diff: Effect.fn(function* ({ id, news, olds }) {
      if (!isResolved(news)) return;
      const oldConsumerName = yield* createConsumerName(id, olds);
      const newConsumerName = yield* createConsumerName(id, news);
      if (oldConsumerName !== newConsumerName) {
        return { action: "replace" } as const;
      }
      if (
        typeof news.streamArn === "string" &&
        typeof olds.streamArn === "string" &&
        news.streamArn !== olds.streamArn
      ) {
        return { action: "replace" } as const;
      }
    }),
    create: Effect.fn(function* ({ id, news, session }) {
      const consumerName = yield* createConsumerName(id, news);
      const streamArn = news.streamArn as string;
      const internalTags = yield* createInternalTags(id);
      const allTags = { ...internalTags, ...news.tags };

      // Engine has cleared us via `read` (foreign-tagged consumers are
      // surfaced as `Unowned`). On a race between read and create, treat
      // `ResourceInUseException` as adoption.
      const consumerArn = yield* kinesis
        .registerStreamConsumer({
          StreamARN: streamArn,
          ConsumerName: consumerName,
          Tags: allTags,
        })
        .pipe(
          Effect.map((response) => response.Consumer.ConsumerARN),
          Effect.catchTag("ResourceInUseException", () =>
            adoptExistingConsumer(streamArn, consumerName).pipe(
              Effect.map((state) => state.consumerArn),
            ),
          ),
        );

      yield* waitForConsumerStatus(consumerArn, "ACTIVE");

      const state = yield* readConsumer({
        consumerArn,
        streamArn,
        consumerName,
      });

      if (!state) {
        return yield* Effect.fail(
          new Error(`failed to read created consumer ${consumerName}`),
        );
      }

      yield* session.note(state.consumerArn);
      return state;
    }),
    update: Effect.fn(function* ({ id, news, olds, output, session }) {
      const internalTags = yield* createInternalTags(id);
      const oldTags = { ...internalTags, ...olds.tags };
      const newTags = { ...internalTags, ...news.tags };
      const { removed, upsert } = diffTags(oldTags, newTags);

      if (removed.length > 0) {
        yield* kinesis.untagResource({
          ResourceARN: output.consumerArn,
          TagKeys: removed,
        });
      }

      if (upsert.length > 0) {
        const tagsToAdd: Record<string, string> = {};
        for (const { Key, Value } of upsert) {
          tagsToAdd[Key] = Value;
        }
        yield* kinesis.tagResource({
          ResourceARN: output.consumerArn,
          Tags: tagsToAdd,
        });
      }

      const state = yield* readConsumer({
        consumerArn: output.consumerArn,
      });
      if (!state) {
        return yield* Effect.fail(
          new Error(`failed to read updated consumer ${output.consumerName}`),
        );
      }

      yield* session.note(output.consumerArn);
      return state;
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* kinesis
        .deregisterStreamConsumer({
          ConsumerARN: output.consumerArn,
        })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));

      yield* waitForConsumerDeleted(output.consumerArn);
    }),
  });
