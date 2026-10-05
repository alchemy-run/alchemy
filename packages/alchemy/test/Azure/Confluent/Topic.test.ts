import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as confluent from "@distilled.cloud/azure/confluent";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  clusterStack,
  logLevel,
  subscription,
  tags,
  waitGone,
  runWithConfluentUser,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (configs: Record<string, string>, partitionsCount: number) =>
  Effect.gen(function* () {
    const parents = yield* clusterStack("topic");
    const topic = yield* Azure.Confluent.Topic("Orders", {
      resourceGroup: parents.group.resourceGroupName,
      organization: parents.organization.organizationName,
      environment: parents.environment.environmentId,
      cluster: parents.cluster.clusterId,
      partitionsCount,
      configs,
    });
    return { ...parents, topic };
  });

// Needs a Confluent organization (Marketplace SaaS purchase, blocked on the
// free trial) and a Basic cluster (usage-billed, well under $1); ~15
// minutes. Run only with AZURE_TEST_PAID=1 and
// AZURE_TEST_CONFLUENT_USER_TOKEN=1 (user sign-in).
test.provider.skipIf(!runWithConfluentUser)(
  "create, update, replace, and delete a confluent topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { topic } = yield* stack.deploy(
        program({ "retention.ms": "86400000" }, 3),
      );
      const getTopic = (topicName: string) =>
        Effect.gen(function* () {
          return yield* confluent.GetTopic({
            subscriptionId: yield* subscription,
            resourceGroupName: topic.resourceGroup,
            organizationName: topic.organization,
            environmentId: topic.environment,
            clusterId: topic.cluster,
            topicName,
          });
        });
      expect(topic.partitionsCount).toEqual(3);
      expect(
        (yield* getTopic(topic.topicName)).properties?.topicId,
      ).toBeDefined();

      // In-place: config overrides.
      const updated = yield* stack.deploy(
        program({ "retention.ms": "172800000" }, 3),
      );
      expect(updated.topic.topicResourceId).toEqual(topic.topicResourceId);

      // Replacement: partition count is fixed at creation.
      const replaced = yield* stack.deploy(
        program({ "retention.ms": "172800000" }, 6),
      );
      expect(replaced.topic.partitionsCount).toEqual(6);

      yield* stack.destroy();
      expect(yield* waitGone(getTopic(replaced.topic.topicName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
