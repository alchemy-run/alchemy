import * as Azure from "@alchemy.run/azure";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, partnerChain, subscription, tags, waitGone } from "./partner.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSubscription = (
  resourceGroupName: string,
  partnerTopicName: string,
  eventSubscriptionName: string,
) =>
  Effect.gen(function* () {
    return yield* eventgrid.GetPartnerTopicEventSubscription({
      subscriptionId: yield* subscription,
      resourceGroupName,
      partnerTopicName,
      eventSubscriptionName,
    });
  });

const eventTypes = {
  "Contoso.OrderCreated": { displayName: "Order created" },
  "Contoso.OrderShipped": { displayName: "Order shipped" },
};

const program = (included: string[]) =>
  partnerChain({
    channel: { eventTypes },
    topic: { tags: { env: "test" } },
    subscription: { eventTypes: included },
  });

// Partner topic + Standard_LRS account + queue cost cents; ~5 minutes.
test.provider(
  "create, update, and delete a partner topic event subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(["Contoso.OrderCreated"]));
      const sub = first.sub!;
      const group = first.group.resourceGroupName;
      const topic = first.topic!.partnerTopicName;
      expect(sub.partnerTopic).toEqual(topic);
      expect(sub.endpointType).toEqual("StorageQueue");
      expect(sub.eventSubscriptionName).toMatch(/^[A-Za-z0-9-]{3,64}$/);
      const observed = yield* getSubscription(group, topic, sub.eventSubscriptionName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.filter?.includedEventTypes).toEqual(["Contoso.OrderCreated"]);
      expect(observed.properties?.eventDeliverySchema).toEqual("CloudEventSchemaV1_0");
      expect(observed.properties?.labels?.[0]).toMatch(/^alchemy:.+\/OrdersCreated$/);

      // In place: the filter.
      const updated = yield* stack.deploy(
        program(["Contoso.OrderCreated", "Contoso.OrderShipped"]),
      );
      expect(updated.sub!.eventSubscriptionName).toEqual(sub.eventSubscriptionName);
      const reobserved = yield* getSubscription(group, topic, sub.eventSubscriptionName);
      expect([...(reobserved.properties?.filter?.includedEventTypes ?? [])].sort()).toEqual([
        "Contoso.OrderCreated",
        "Contoso.OrderShipped",
      ]);

      yield* stack.destroy();
      expect(yield* waitGone(getSubscription(group, topic, sub.eventSubscriptionName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
