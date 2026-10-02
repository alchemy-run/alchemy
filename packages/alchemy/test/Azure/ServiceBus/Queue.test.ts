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

const getQueue = (
  resourceGroupName: string,
  namespaceName: string,
  queueName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetQueue({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      queueName,
    });
  });

const queueGone = (
  resourceGroupName: string,
  namespaceName: string,
  queueName: string,
) =>
  getQueue(resourceGroupName, namespaceName, queueName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
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
  defaultMessageTimeToLive?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bus = yield* Azure.ServiceBus.Namespace("Bus", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const poison = yield* Azure.ServiceBus.Queue("Poison", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
    });
    const orders = yield* Azure.ServiceBus.Queue("Orders", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      lockDuration: "PT30S",
      requiresSession: props.requiresSession,
      maxDeliveryCount: props.maxDeliveryCount,
      defaultMessageTimeToLive: props.defaultMessageTimeToLive,
      forwardDeadLetteredMessagesTo: poison.queueName,
      userMetadata: "orders",
    });
    return { group, bus, poison, orders };
  });

// Standard namespace + two queues: ~$0.0135/h, a few minutes per run (<$0.01).
test.provider(
  "create, update, replace, and delete a service bus queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, poison, orders } = yield* stack.deploy(
        program({ requiresSession: false, maxDeliveryCount: 5 }),
      );
      expect(orders.queueName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      expect(orders.requiresSession).toEqual(false);
      expect(orders.userMetadata).toEqual("orders");
      const rg = group.resourceGroupName;
      const observed = yield* getQueue(rg, bus.namespaceName, orders.queueName);
      expect(observed.properties?.lockDuration).toEqual("PT30S");
      expect(observed.properties?.maxDeliveryCount).toEqual(5);
      expect(observed.properties?.forwardDeadLetteredMessagesTo).toEqual(
        poison.queueName,
      );
      expect(observed.properties?.userMetadata).toMatch(
        /^orders \[alchemy .+\/Orders\]$/,
      );

      // In place: maxDeliveryCount and TTL.
      const updated = yield* stack.deploy(
        program({
          requiresSession: false,
          maxDeliveryCount: 7,
          defaultMessageTimeToLive: "P1D",
        }),
      );
      expect(updated.orders.queueName).toEqual(orders.queueName);
      const reobserved = yield* getQueue(
        rg,
        bus.namespaceName,
        orders.queueName,
      );
      expect(reobserved.properties?.maxDeliveryCount).toEqual(7);
      expect(reobserved.properties?.defaultMessageTimeToLive).toEqual("P1D");
      expect(reobserved.properties?.lockDuration).toEqual("PT30S");

      // Replacement: sessions are immutable.
      const replaced = yield* stack.deploy(
        program({
          requiresSession: true,
          maxDeliveryCount: 7,
          defaultMessageTimeToLive: "P1D",
        }),
      );
      expect(replaced.orders.queueName).not.toEqual(orders.queueName);
      expect(replaced.orders.requiresSession).toEqual(true);
      const sessionQueue = yield* getQueue(
        rg,
        bus.namespaceName,
        replaced.orders.queueName,
      );
      expect(sessionQueue.properties?.requiresSession).toEqual(true);
      expect(yield* queueGone(rg, bus.namespaceName, orders.queueName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* queueGone(rg, bus.namespaceName, replaced.orders.queueName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
