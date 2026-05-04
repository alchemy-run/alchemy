import * as AWS from "@/AWS";
import { Topic } from "@/AWS/SNS";
import * as Test from "@/Test/Vitest";
import * as SNS from "@distilled.cloud/aws/sns";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.SNS.Topic", () => {
  test.provider("create and delete topic with default props", (stack) =>
    Effect.gen(function* () {
      const topic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("DefaultTopic");
        }),
      );

      expect(topic.topicName).toBeDefined();
      expect(topic.topicArn).toBeDefined();

      const attributes = yield* SNS.getTopicAttributes({
        TopicArn: topic.topicArn,
      });
      expect(attributes.Attributes?.TopicArn).toBe(topic.topicArn);

      yield* stack.destroy();
      yield* assertTopicDeleted(topic.topicArn);
    }),
  );

  test.provider("create, update, delete topic attributes and tags", (stack) =>
    Effect.gen(function* () {
      const topic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("ManagedTopic", {
            attributes: {
              DisplayName: "managed-topic-v1",
            },
            tags: {
              env: "test",
            },
          });
        }),
      );

      const initialAttributes = yield* SNS.getTopicAttributes({
        TopicArn: topic.topicArn,
      });
      expect(initialAttributes.Attributes?.DisplayName).toBe(
        "managed-topic-v1",
      );

      const updatedTopic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("ManagedTopic", {
            attributes: {
              DisplayName: "managed-topic-v2",
            },
            tags: {
              updated: "true",
            },
          });
        }),
      );

      const updatedAttributes = yield* SNS.getTopicAttributes({
        TopicArn: updatedTopic.topicArn,
      });
      expect(updatedAttributes.Attributes?.DisplayName).toBe(
        "managed-topic-v2",
      );

      const tagResponse = yield* SNS.listTagsForResource({
        ResourceArn: updatedTopic.topicArn,
      });
      const tags = Object.fromEntries(
        (tagResponse.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      );
      expect(tags.updated).toBe("true");
      expect(tags.env).toBeUndefined();

      yield* stack.destroy();
      yield* assertTopicDeleted(updatedTopic.topicArn);
    }),
  );

  test.provider("create and delete fifo topic", (stack) =>
    Effect.gen(function* () {
      const topic = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Topic("FifoTopic", {
            fifo: true,
            attributes: {
              ContentBasedDeduplication: "true",
            },
          });
        }),
      );

      expect(topic.topicName).toContain(".fifo");

      const attributes = yield* SNS.getTopicAttributes({
        TopicArn: topic.topicArn,
      });
      expect(attributes.Attributes?.FifoTopic).toBe("true");
      expect(attributes.Attributes?.ContentBasedDeduplication).toBe("true");

      yield* stack.destroy();
      yield* assertTopicDeleted(topic.topicArn);
    }),
  );

  class TopicStillExists extends Data.TaggedError("TopicStillExists") {}

  const assertTopicDeleted = Effect.fn(function* (topicArn: string) {
    yield* SNS.getTopicAttributes({
      TopicArn: topicArn,
    }).pipe(
      Effect.flatMap(() => Effect.fail(new TopicStillExists())),
      Effect.retry({
        while: (error) => error._tag === "TopicStillExists",
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFoundException", () => Effect.void),
      Effect.catchTag("InvalidParameterException", () => Effect.void),
    );
  });
});
