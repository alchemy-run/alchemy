import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as SNS from "@distilled.cloud/aws/sns";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { SNSFixture } from "./handler";

test(
  "create and delete lambda subscription",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    const fixture = yield* test.deploy(SNSFixture);

    expect(fixture.subscription.subscriptionArn).toBeDefined();

    const attributes = yield* SNS.getSubscriptionAttributes({
      SubscriptionArn: fixture.subscription.subscriptionArn,
    }).pipe(
      Effect.tapError((err) =>
        Effect.logError(fixture.subscription.subscriptionArn, err),
      ),
      Effect.retry({
        while: (error) => error._tag === "NotFoundException",
        schedule: Schedule.fixed(300),
      }),
    );
    expect(attributes.Attributes?.Protocol).toBe("lambda");
    expect(attributes.Attributes?.TopicArn).toBe(fixture.topic.topicArn);

    yield* destroy();
    yield* assertSubscriptionDeleted(fixture.subscription.subscriptionArn);
  }).pipe(Effect.provide(AWS.providers())),
);

class SubscriptionStillExists extends Data.TaggedError(
  "SubscriptionStillExists",
) {}

const assertSubscriptionDeleted = Effect.fn(function* (
  subscriptionArn: string,
) {
  yield* SNS.getSubscriptionAttributes({
    SubscriptionArn: subscriptionArn,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new SubscriptionStillExists())),
    Effect.retry({
      while: (error) => error._tag === "SubscriptionStillExists",
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.catchTag("InvalidParameterException", () => Effect.void),
  );
});
