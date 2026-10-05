import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as iothub from "@distilled.cloud/azure/iothub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone, withFreeHub } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConsumerGroup = (
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iothub.GetIotHubResourceEventHubConsumerGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      eventHubEndpointName: "events",
      name,
    });
  });

const program = (props: { name: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const hub = yield* Azure.IoTHub.IotHub("Hub", {
      resourceGroup: group.resourceGroupName,
      sku: "F1",
      partitionCount: 2,
    });
    const consumers = yield* Azure.IoTHub.ConsumerGroup("Analytics", {
      resourceGroup: group.resourceGroupName,
      iotHub: hub.iotHubName,
      name: props.name,
    });
    return { group, hub, consumers };
  });

// F1 hub: free. Consumer groups have no mutable properties, so the update
// step is a rename (replacement). ~4 minutes end to end.
test.provider(
  "create, replace, and delete an IoT hub consumer group",
  (stack) =>
    withFreeHub(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, hub, consumers } = yield* stack.deploy(
          program({ name: "analytics" }),
        );
        expect(consumers.consumerGroupName).toEqual("analytics");
        expect(consumers.eventHubEndpointName).toEqual("events");
        const get = (name: string) =>
          getConsumerGroup(group.resourceGroupName, hub.iotHubName, name);
        expect((yield* get("analytics")).name).toEqual("analytics");

        // No-op redeploy keeps the same consumer group.
        const same = yield* stack.deploy(program({ name: "analytics" }));
        expect(same.consumers.consumerGroupId).toEqual(
          consumers.consumerGroupId,
        );

        // Replacement: rename.
        const replaced = yield* stack.deploy(program({ name: "alerts" }));
        expect(replaced.consumers.consumerGroupName).toEqual("alerts");
        expect((yield* get("alerts")).name).toEqual("alerts");
        expect(yield* waitGone(get("analytics"))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get("alerts"))).toEqual("gone");
      }).pipe(logLevel),
    ),
  { tags, timeout: 900_000 },
);
