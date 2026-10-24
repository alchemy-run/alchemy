import * as Azure from "@alchemy.run/azure";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, partnerChain, subscription, tags, waitGone } from "./partner.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPartnerTopic = (resourceGroupName: string, partnerTopicName: string) =>
  Effect.gen(function* () {
    return yield* eventgrid.GetPartnerTopic({
      subscriptionId: yield* subscription,
      resourceGroupName,
      partnerTopicName,
    });
  });

const getChannel = (resourceGroupName: string, partnerNamespaceName: string, channelName: string) =>
  Effect.gen(function* () {
    return yield* eventgrid.GetChannel({
      subscriptionId: yield* subscription,
      resourceGroupName,
      partnerNamespaceName,
      channelName,
    });
  });

const eventTypes = { "Contoso.OrderCreated": { displayName: "Order created" } };

// Partner topics bill per operation only; ~4 minutes.
test.provider(
  "activate, update, replace, and delete an event grid partner topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        partnerChain({ channel: { eventTypes }, topic: { tags: { env: "test" } } }),
      );
      const topic = first.topic!;
      const group = first.group.resourceGroupName;
      expect(topic.partnerTopicName).toEqual(first.channel!.partnerTopicName);
      expect(topic.activationState).toEqual("Activated");
      expect(topic.eventTypes).toEqual(["Contoso.OrderCreated"]);
      expect(topic.source).toEqual("contoso/tenants/alchemy-test");
      expect(topic.tags).toEqual({ env: "test" });
      const observed = yield* getPartnerTopic(group, topic.partnerTopicName);
      expect(observed.properties?.activationState).toEqual("Activated");
      expect(observed.tags?.["alchemy::id"]).toEqual("OrdersTopic");
      // Activation is visible on the partner's channel.
      const channel = yield* getChannel(
        group,
        first.namespace.partnerNamespaceName,
        first.channel!.channelName,
      );
      expect(channel.properties?.readinessState).toEqual("Activated");

      // In place: tags.
      const updated = yield* stack.deploy(
        partnerChain({ channel: { eventTypes }, topic: { tags: { env: "prod" } } }),
      );
      expect(updated.topic!.partnerTopicName).toEqual(topic.partnerTopicName);
      const reobserved = yield* getPartnerTopic(group, topic.partnerTopicName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new channel creates a new partner topic.
      const replaced = yield* stack.deploy(
        partnerChain({
          channel: { eventTypes, source: "contoso/tenants/alchemy-test-2" },
          topic: { tags: { env: "prod" } },
        }),
      );
      const replacement = replaced.topic!;
      expect(replacement.partnerTopicName).not.toEqual(topic.partnerTopicName);
      expect(replacement.activationState).toEqual("Activated");
      const replacementObserved = yield* getPartnerTopic(group, replacement.partnerTopicName);
      expect(replacementObserved.properties?.source).toEqual("contoso/tenants/alchemy-test-2");
      expect(yield* waitGone(getPartnerTopic(group, topic.partnerTopicName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getPartnerTopic(group, replacement.partnerTopicName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
