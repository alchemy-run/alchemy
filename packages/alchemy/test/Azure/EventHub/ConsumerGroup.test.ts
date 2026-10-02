import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConsumerGroup = (
  resourceGroupName: string,
  namespaceName: string,
  eventHubName: string,
  consumerGroupName: string,
) =>
  Effect.gen(function* () {
    return yield* eventhub.GetConsumerGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      eventHubName,
      consumerGroupName,
    });
  });

const program = (props: { name: string; userMetadata: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Basic namespaces only have the built-in `$Default` consumer group.
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const hub = yield* Azure.EventHub.EventHub("Orders", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      partitionCount: 1,
    });
    const consumers = yield* Azure.EventHub.ConsumerGroup("Billing", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      eventHub: hub.eventHubName,
      name: props.name,
      userMetadata: props.userMetadata,
    });
    return { group, namespace, hub, consumers };
  });

// Standard namespace (~$0.03/hour) for a few minutes: well under $0.05.
test.provider(
  "create, update, replace, and delete a consumer group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, hub, consumers } = yield* stack.deploy(
        program({ name: "billing", userMetadata: "billing v1" }),
      );
      expect(consumers.consumerGroupName).toEqual("billing");
      expect(consumers.userMetadata).toEqual("billing v1");
      const get = (name: string) =>
        getConsumerGroup(
          group.resourceGroupName,
          namespace.namespaceName,
          hub.eventHubName,
          name,
        );
      const observed = yield* get("billing");
      expect(observed.properties?.userMetadata).toMatch(
        /^billing v1 \[alchemy .+\/Billing\]$/,
      );

      // In-place: user metadata.
      const updated = yield* stack.deploy(
        program({ name: "billing", userMetadata: "billing v2" }),
      );
      expect(updated.consumers.consumerGroupId).toEqual(
        consumers.consumerGroupId,
      );
      expect((yield* get("billing")).properties?.userMetadata).toMatch(
        /^billing v2 \[alchemy /,
      );

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "invoicing", userMetadata: "billing v2" }),
      );
      expect(replaced.consumers.consumerGroupName).toEqual("invoicing");
      expect((yield* get("invoicing")).name).toEqual("invoicing");
      expect(yield* waitGone(get("billing"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("invoicing"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
