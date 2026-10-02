import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
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
  subscriptionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetSubscription({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
      subscriptionName,
    });
  });

const subscriptionGone = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
  subscriptionName: string,
) =>
  getSubscription(
    resourceGroupName,
    namespaceName,
    topicName,
    subscriptionName,
  ).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      [
        "ResourceNotFound",
        "ResourceGroupNotFound",
        "NotFound",
        "SubscriptionNotFound",
      ],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  requiresSession: boolean;
  maxDeliveryCount: number;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bus = yield* Azure.ServiceBus.Namespace("Bus", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const events = yield* Azure.ServiceBus.Topic("Events", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
    });
    const audit = yield* Azure.ServiceBus.Subscription("Audit", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      topic: events.topicName,
      lockDuration: "PT45S",
      ...props,
    });
    return { group, bus, events, audit };
  });

// Standard namespace + topic + subscription: ~$0.0135/h, a few minutes (<$0.01).
test.provider(
  "create, update, replace, and delete a service bus subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, events, audit } = yield* stack.deploy(
        program({ requiresSession: false, maxDeliveryCount: 5 }),
      );
      const rg = group.resourceGroupName;
      const ns = bus.namespaceName;
      expect(audit.subscriptionName.length).toBeLessThanOrEqual(50);
      expect(audit.subscriptionResourceId).toContain(
        `/topics/${events.topicName}/subscriptions/${audit.subscriptionName}`,
      );
      const observed = yield* getSubscription(
        rg,
        ns,
        events.topicName,
        audit.subscriptionName,
      );
      expect(observed.properties?.maxDeliveryCount).toEqual(5);
      expect(observed.properties?.lockDuration).toEqual("PT45S");
      expect(observed.properties?.userMetadata).toMatch(
        /^\[alchemy .+\/Audit\]$/,
      );

      // In place: maxDeliveryCount.
      const updated = yield* stack.deploy(
        program({ requiresSession: false, maxDeliveryCount: 9 }),
      );
      expect(updated.audit.subscriptionName).toEqual(audit.subscriptionName);
      const reobserved = yield* getSubscription(
        rg,
        ns,
        events.topicName,
        audit.subscriptionName,
      );
      expect(reobserved.properties?.maxDeliveryCount).toEqual(9);

      // Replacement: sessions are immutable.
      const replaced = yield* stack.deploy(
        program({ requiresSession: true, maxDeliveryCount: 9 }),
      );
      expect(replaced.audit.subscriptionName).not.toEqual(
        audit.subscriptionName,
      );
      const sessions = yield* getSubscription(
        rg,
        ns,
        events.topicName,
        replaced.audit.subscriptionName,
      );
      expect(sessions.properties?.requiresSession).toEqual(true);
      expect(
        yield* subscriptionGone(
          rg,
          ns,
          events.topicName,
          audit.subscriptionName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* subscriptionGone(
          rg,
          ns,
          events.topicName,
          replaced.audit.subscriptionName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
