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
  systemTopicName: string,
  eventSubscriptionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetSystemTopicEventSubscription({
      subscriptionId,
      resourceGroupName,
      systemTopicName,
      eventSubscriptionName,
    });
  });

const subscriptionGone = (
  resourceGroupName: string,
  systemTopicName: string,
  eventSubscriptionName: string,
) =>
  getSubscription(
    resourceGroupName,
    systemTopicName,
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

// Storage queues are not an Alchemy resource yet; create one out of band.
// It is deleted with the storage account.
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

const program = (subscription?: { prefix: string; eventTypes: string[] }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: group.resourceGroupName,
    });
    const systemTopic = yield* Azure.EventGrid.SystemTopic("FilesEvents", {
      resourceGroup: group.resourceGroupName,
      source: account.storageAccountId,
      topicType: "Microsoft.Storage.StorageAccounts",
      location: "eastus",
    });
    const sub = subscription
      ? yield* Azure.EventGrid.SystemTopicEventSubscription("Uploads", {
          resourceGroup: group.resourceGroupName,
          systemTopic: systemTopic.systemTopicName,
          destination: {
            endpointType: "StorageQueue",
            resourceId: account.storageAccountId,
            queueName: "uploads",
          },
          filter: {
            includedEventTypes: subscription.eventTypes,
            subjectBeginsWith: subscription.prefix,
          },
        })
      : undefined;
    return { group, account, systemTopic, sub };
  });

// System topic is free; Standard_LRS account + queue cost cents; ~4 minutes.
test.provider(
  "create, update, and delete a system topic event subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, systemTopic } = yield* stack.deploy(program());
      yield* createQueue(
        group.resourceGroupName,
        account.storageAccountName,
        "uploads",
      );

      const created = yield* stack.deploy(
        program({
          prefix: "/blobServices/default/containers/uploads/",
          eventTypes: ["Microsoft.Storage.BlobCreated"],
        }),
      );
      const sub = created.sub!;
      expect(sub.systemTopic).toEqual(systemTopic.systemTopicName);
      expect(sub.endpointType).toEqual("StorageQueue");
      const observed = yield* getSubscription(
        group.resourceGroupName,
        systemTopic.systemTopicName,
        sub.eventSubscriptionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.filter?.subjectBeginsWith).toEqual(
        "/blobServices/default/containers/uploads/",
      );
      expect(observed.properties?.destination?.properties).toMatchObject({
        queueName: "uploads",
      });

      // In-place: filter.
      const updated = yield* stack.deploy(
        program({
          prefix: "/blobServices/default/containers/images/",
          eventTypes: [
            "Microsoft.Storage.BlobCreated",
            "Microsoft.Storage.BlobDeleted",
          ],
        }),
      );
      expect(updated.sub!.eventSubscriptionName).toEqual(
        sub.eventSubscriptionName,
      );
      const reobserved = yield* getSubscription(
        group.resourceGroupName,
        systemTopic.systemTopicName,
        sub.eventSubscriptionName,
      );
      expect(reobserved.properties?.filter?.subjectBeginsWith).toEqual(
        "/blobServices/default/containers/images/",
      );
      expect(
        [...(reobserved.properties?.filter?.includedEventTypes ?? [])].sort(),
      ).toEqual([
        "Microsoft.Storage.BlobCreated",
        "Microsoft.Storage.BlobDeleted",
      ]);

      yield* stack.destroy();
      expect(
        yield* subscriptionGone(
          group.resourceGroupName,
          systemTopic.systemTopicName,
          sub.eventSubscriptionName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
