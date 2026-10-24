import * as Azure from "@alchemy.run/azure";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, partnerChain, subscription, tags, waitGone } from "./partner.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getChannel = (resourceGroupName: string, partnerNamespaceName: string, channelName: string) =>
  Effect.gen(function* () {
    return yield* eventgrid.GetChannel({
      subscriptionId: yield* subscription,
      resourceGroupName,
      partnerNamespaceName,
      channelName,
    });
  });

const getPartnerTopic = (resourceGroupName: string, partnerTopicName: string) =>
  Effect.gen(function* () {
    return yield* eventgrid.GetPartnerTopic({
      subscriptionId: yield* subscription,
      resourceGroupName,
      partnerTopicName,
    });
  });

const created = { "Contoso.OrderCreated": { displayName: "Order created" } };

// Channels and never-activated partner topics are free; ~3 minutes.
test.provider(
  "create, update, replace, and delete an event grid channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(partnerChain({ channel: { eventTypes: created } }));
      const channel = first.channel!;
      const group = first.group.resourceGroupName;
      const namespace = first.namespace.partnerNamespaceName;
      expect(channel.channelName).toMatch(/^[A-Za-z0-9-]{3,50}$/);
      expect(channel.partnerTopicName).toEqual(channel.channelName);
      expect(channel.partnerTopicResourceGroup).toEqual(group);
      expect(channel.readinessState).toEqual("NeverActivated");
      const observed = yield* getChannel(group, namespace, channel.channelName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.channelType).toEqual("PartnerTopic");
      expect(observed.properties?.messageForActivation).toEqual(
        "Activate to receive Contoso order events.",
      );
      // The channel created the partner topic in the subscriber's group.
      const topic = yield* getPartnerTopic(group, channel.partnerTopicName);
      expect(topic.properties?.activationState).toEqual("NeverActivated");
      expect(topic.properties?.source).toEqual("contoso/tenants/alchemy-test");
      expect(topic.properties?.partnerRegistrationImmutableId).toEqual(
        first.registration.partnerRegistrationImmutableId,
      );

      // In place: the advertised event types.
      const updated = yield* stack.deploy(
        partnerChain({
          channel: {
            eventTypes: {
              ...created,
              "Contoso.OrderShipped": { displayName: "Order shipped", description: "Shipped" },
            },
          },
        }),
      );
      expect(updated.channel!.channelName).toEqual(channel.channelName);
      const reobserved = yield* getChannel(group, namespace, channel.channelName);
      expect(
        Object.keys(reobserved.properties?.partnerTopicInfo?.eventTypeInfo?.inlineEventTypes ?? {})
          .sort()
          .join(","),
      ).toEqual("Contoso.OrderCreated,Contoso.OrderShipped");

      // Replacement: the partner topic source.
      const replaced = yield* stack.deploy(
        partnerChain({
          channel: { eventTypes: created, source: "contoso/tenants/alchemy-test-2" },
        }),
      );
      const replacement = replaced.channel!;
      expect(replacement.channelName).not.toEqual(channel.channelName);
      const replacementTopic = yield* getPartnerTopic(group, replacement.partnerTopicName);
      expect(replacementTopic.properties?.source).toEqual("contoso/tenants/alchemy-test-2");
      expect(yield* waitGone(getChannel(group, namespace, channel.channelName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getChannel(group, namespace, replacement.channelName))).toEqual(
        "gone",
      );
      expect(yield* waitGone(getPartnerTopic(group, replacement.partnerTopicName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
