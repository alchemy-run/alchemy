import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as storage from "@distilled.cloud/azure/storage";
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
  domainName: string,
  eventSubscriptionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetDomainEventSubscription({
      subscriptionId,
      resourceGroupName,
      domainName,
      eventSubscriptionName,
    });
  });

const subscriptionGone = (
  resourceGroupName: string,
  domainName: string,
  eventSubscriptionName: string,
) =>
  getSubscription(resourceGroupName, domainName, eventSubscriptionName).pipe(
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

// Storage queues are not an Alchemy resource yet; create them out of band.
// They are deleted with the storage account.
const createQueue = (
  resourceGroupName: string,
  accountName: string,
  queueName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* storage.CreateQueue({
      subscriptionId,
      resourceGroupName,
      accountName,
      queueName,
    });
  });

interface Shape {
  subscription?: {
    queueName: string;
    labels: string[];
    eventTypes: string[];
    maxDeliveryAttempts: number;
    eventDeliverySchema?: "EventGridSchema" | "CloudEventSchemaV1_0";
  };
}

const program = (shape: Shape) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Sink", {
      resourceGroup: group.resourceGroupName,
    });
    const domain = yield* Azure.EventGrid.Domain("Orders", {
      resourceGroup: group.resourceGroupName,
    });
    const sub = shape.subscription;
    const subscription = sub
      ? yield* Azure.EventGrid.DomainEventSubscription("OrdersToQueue", {
          resourceGroup: group.resourceGroupName,
          domain: domain.domainName,
          destination: {
            endpointType: "StorageQueue",
            resourceId: account.storageAccountId,
            queueName: sub.queueName,
          },
          filter: { includedEventTypes: sub.eventTypes },
          labels: sub.labels,
          retryPolicy: {
            maxDeliveryAttempts: sub.maxDeliveryAttempts,
            eventTimeToLiveInMinutes: 60,
          },
          eventDeliverySchema: sub.eventDeliverySchema,
        })
      : undefined;
    return { group, account, domain, subscription };
  });

// Domain is free, Standard_LRS storage account + queues cost cents; ~5 minutes.
test.provider(
  "create, update, replace, and delete an event subscription on a domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program({}));
      const { group, account, domain } = base;
      yield* createQueue(
        group.resourceGroupName,
        account.storageAccountName,
        "orders-a",
      );
      yield* createQueue(
        group.resourceGroupName,
        account.storageAccountName,
        "orders-b",
      );

      const created = yield* stack.deploy(
        program({
          subscription: {
            queueName: "orders-a",
            labels: ["orders"],
            eventTypes: ["Order.Created"],
            maxDeliveryAttempts: 10,
          },
        }),
      );
      const subscription = created.subscription!;
      expect(subscription.endpointType).toEqual("StorageQueue");
      expect(subscription.labels).toEqual(["orders"]);
      expect(subscription.topic?.toLowerCase()).toEqual(
        domain.domainId.toLowerCase(),
      );
      const observed = yield* getSubscription(
        group.resourceGroupName,
        domain.domainName,
        subscription.eventSubscriptionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.destination?.endpointType).toEqual(
        "StorageQueue",
      );
      expect(observed.properties?.destination?.properties).toMatchObject({
        queueName: "orders-a",
      });
      expect(observed.properties?.filter?.includedEventTypes).toEqual([
        "Order.Created",
      ]);
      expect(observed.properties?.retryPolicy?.maxDeliveryAttempts).toEqual(10);
      expect(
        observed.properties?.labels?.some((l) => l.startsWith("alchemy:")),
      ).toEqual(true);

      // In-place: destination queue, filter, labels, and retry policy.
      const updated = yield* stack.deploy(
        program({
          subscription: {
            queueName: "orders-b",
            labels: ["orders", "v2"],
            eventTypes: ["Order.Created", "Order.Shipped"],
            maxDeliveryAttempts: 5,
          },
        }),
      );
      expect(updated.subscription!.eventSubscriptionName).toEqual(
        subscription.eventSubscriptionName,
      );
      const reobserved = yield* getSubscription(
        group.resourceGroupName,
        domain.domainName,
        subscription.eventSubscriptionName,
      );
      expect(reobserved.properties?.destination?.properties).toMatchObject({
        queueName: "orders-b",
      });
      expect(
        [...(reobserved.properties?.filter?.includedEventTypes ?? [])].sort(),
      ).toEqual(["Order.Created", "Order.Shipped"]);
      expect(reobserved.properties?.retryPolicy?.maxDeliveryAttempts).toEqual(
        5,
      );
      expect(updated.subscription!.labels.sort()).toEqual(["orders", "v2"]);

      // The delivery schema is immutable: changing it replaces.
      const replaced = yield* stack.deploy(
        program({
          subscription: {
            queueName: "orders-b",
            labels: ["orders", "v2"],
            eventTypes: ["Order.Created", "Order.Shipped"],
            maxDeliveryAttempts: 5,
            eventDeliverySchema: "CloudEventSchemaV1_0",
          },
        }),
      );
      const replacement = replaced.subscription!;
      expect(replacement.eventSubscriptionName).not.toEqual(
        subscription.eventSubscriptionName,
      );
      expect(replacement.eventDeliverySchema).toEqual("CloudEventSchemaV1_0");
      expect(
        yield* subscriptionGone(
          group.resourceGroupName,
          domain.domainName,
          subscription.eventSubscriptionName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* subscriptionGone(
          group.resourceGroupName,
          domain.domainName,
          replacement.eventSubscriptionName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
