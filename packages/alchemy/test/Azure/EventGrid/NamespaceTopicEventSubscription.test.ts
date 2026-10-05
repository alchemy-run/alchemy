import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getSubscription = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
  eventSubscriptionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetNamespaceTopicEventSubscription({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
      eventSubscriptionName,
    });
  });

const subscriptionGone = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
  eventSubscriptionName: string,
) =>
  getSubscription(
    resourceGroupName,
    namespaceName,
    topicName,
    eventSubscriptionName,
  ).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  maxDeliveryCount: number;
  eventTypes: string[];
  name?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventGrid.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
    });
    const topic = yield* Azure.EventGrid.NamespaceTopic("Orders", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      eventRetentionInDays: 1,
    });
    const subscription = yield* Azure.EventGrid.NamespaceTopicEventSubscription(
      "Workers",
      {
        resourceGroup: group.resourceGroupName,
        namespace: namespace.namespaceName,
        topic: topic.namespaceTopicName,
        name: props.name,
        queue: {
          maxDeliveryCount: props.maxDeliveryCount,
          receiveLockDurationInSeconds: 60,
        },
        includedEventTypes: props.eventTypes,
      },
    );
    return { group, namespace, topic, subscription };
  });

// One throughput unit for ~10 minutes; well under $0.10.
test.provider(
  "create, update, rename, and delete an event grid namespace topic subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, topic, subscription } = yield* stack.deploy(
        program({ maxDeliveryCount: 5, eventTypes: ["Order.Created"] }),
      );
      expect(subscription.deliveryMode).toEqual("Queue");
      const where = [
        group.resourceGroupName,
        namespace.namespaceName,
        topic.namespaceTopicName,
      ] as const;
      const observed = yield* getSubscription(
        ...where,
        subscription.eventSubscriptionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.deliveryConfiguration?.queue?.maxDeliveryCount,
      ).toEqual(5);
      expect(
        observed.properties?.filtersConfiguration?.includedEventTypes,
      ).toEqual(["Order.Created"]);

      // In place: delivery count and filters.
      const updated = yield* stack.deploy(
        program({
          maxDeliveryCount: 8,
          eventTypes: ["Order.Created", "Order.Shipped"],
        }),
      );
      expect(updated.subscription.eventSubscriptionName).toEqual(
        subscription.eventSubscriptionName,
      );
      const reobserved = yield* getSubscription(
        ...where,
        subscription.eventSubscriptionName,
      );
      expect(
        reobserved.properties?.deliveryConfiguration?.queue?.maxDeliveryCount,
      ).toEqual(8);
      expect(
        [
          ...(reobserved.properties?.filtersConfiguration?.includedEventTypes ??
            []),
        ].sort(),
      ).toEqual(["Order.Created", "Order.Shipped"]);

      // Renaming replaces the subscription.
      const renamed = yield* stack.deploy(
        program({
          maxDeliveryCount: 8,
          eventTypes: ["Order.Created"],
          name: "workers-renamed",
        }),
      );
      expect(renamed.subscription.eventSubscriptionName).toEqual(
        "workers-renamed",
      );
      expect(
        yield* subscriptionGone(...where, subscription.eventSubscriptionName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* subscriptionGone(...where, "workers-renamed")).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
