import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sns from "@distilled.cloud/aws/sns";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:sns", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "TopicLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const topic = yield* AWS.SNS.Topic("lookup-target");
    return {
      topicName: topic.topicName.as<string>(),
      topicArn: topic.topicArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up topic resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { topicName, topicArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.SNS.Topic.lookup({ topicName });
          const byArn = AWS.SNS.Topic.lookup({ topicArn });
          return { arn: byName.topicArn, name: byArn.topicName };
        },
        {
          arn: topicArn,
          name: topicName,
        },
      );
      const survivor = yield* sns.getTopicAttributes({ TopicArn: topicArn });
      expect(survivor.Attributes?.TopicArn).toBe(topicArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing topic fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-topic", {
            value: AWS.SNS.Topic.lookup({ topicName: name }).topicArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a topic this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.SNS.Topic("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-topic-consumer", {
              value: AWS.SNS.Topic.lookup({ topicName: attrs.topicName }).topicArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
