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

const getTopic = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetNamespaceTopic({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
    });
  });

const topicGone = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
) =>
  getTopic(resourceGroupName, namespaceName, topicName).pipe(
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

const program = (props: { retention: number; name?: string }) =>
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
      name: props.name,
      eventRetentionInDays: props.retention,
    });
    return { group, namespace, topic };
  });

// One throughput unit for ~10 minutes; well under $0.10.
test.provider(
  "create, update, rename, and delete an event grid namespace topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, topic } = yield* stack.deploy(
        program({ retention: 1 }),
      );
      expect(topic.eventRetentionInDays).toEqual(1);
      expect(topic.primaryKey).toBeDefined();
      const observed = yield* getTopic(
        group.resourceGroupName,
        namespace.namespaceName,
        topic.namespaceTopicName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.inputSchema).toEqual("CloudEventSchemaV1_0");

      const updated = yield* stack.deploy(program({ retention: 3 }));
      expect(updated.topic.namespaceTopicName).toEqual(
        topic.namespaceTopicName,
      );
      const reobserved = yield* getTopic(
        group.resourceGroupName,
        namespace.namespaceName,
        topic.namespaceTopicName,
      );
      expect(reobserved.properties?.eventRetentionInDays).toEqual(3);

      // Renaming replaces the topic.
      const renamed = yield* stack.deploy(
        program({ retention: 3, name: "orders-renamed" }),
      );
      expect(renamed.topic.namespaceTopicName).toEqual("orders-renamed");
      expect(
        yield* topicGone(
          group.resourceGroupName,
          namespace.namespaceName,
          topic.namespaceTopicName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* topicGone(
          group.resourceGroupName,
          namespace.namespaceName,
          "orders-renamed",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
