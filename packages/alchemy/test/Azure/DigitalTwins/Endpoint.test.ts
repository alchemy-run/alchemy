import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as digitaltwins from "@distilled.cloud/azure/digitaltwins";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  resourceName: string,
  endpointName: string,
) =>
  Effect.gen(function* () {
    return yield* digitaltwins.GetDigitalTwinsEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      endpointName,
    });
  });

const program = (props: { topic: "A" | "B"; name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const instance = yield* Azure.DigitalTwins.Instance("Twins", {
      resourceGroup: group.resourceGroupName,
    });
    // Both topics stay deployed across every step.
    const topicA = yield* Azure.EventGrid.Topic("TopicA", {
      resourceGroup: group.resourceGroupName,
    });
    const topicB = yield* Azure.EventGrid.Topic("TopicB", {
      resourceGroup: group.resourceGroupName,
    });
    const topic = props.topic === "A" ? topicA : topicB;
    const endpoint = yield* Azure.DigitalTwins.Endpoint("Events", {
      resourceGroup: group.resourceGroupName,
      instance: instance.instanceName,
      name: props.name,
      endpointType: "EventGrid",
      topicEndpoint: topic.endpoint,
      accessKey1: topic.primaryKey,
      accessKey2: topic.secondaryKey,
    });
    return { group, instance, topic, endpoint };
  });

// Digital Twins instance (per-operation billing) + two Event Grid topics
// (per-operation billing): ~$0 per run, ~5 minutes.
test.provider(
  "create, update, replace, and delete a Digital Twins endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, topic, endpoint } = yield* stack.deploy(
        program({ topic: "A" }),
      );
      const get = (name: string) =>
        getEndpoint(group.resourceGroupName, instance.instanceName, name);
      expect(endpoint.endpointType).toEqual("EventGrid");
      expect(endpoint.provisioningState).toEqual("Succeeded");
      const observed = yield* get(endpoint.endpointName);
      expect(observed.properties.endpointType).toEqual("EventGrid");
      expect(observed.properties.authenticationType).toEqual("KeyBased");
      expect(observed.properties.TopicEndpoint).toEqual(topic.endpoint);

      // In-place: point the endpoint at the other topic.
      const updated = yield* stack.deploy(program({ topic: "B" }));
      expect(updated.endpoint.endpointId).toEqual(endpoint.endpointId);
      const reobserved = yield* get(endpoint.endpointName);
      expect(reobserved.properties.TopicEndpoint).toEqual(
        updated.topic.endpoint,
      );
      expect(reobserved.properties.TopicEndpoint).not.toEqual(topic.endpoint);
      expect(reobserved.properties.provisioningState).toEqual("Succeeded");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({ topic: "B", name: "events-renamed" }),
      );
      expect(replaced.endpoint.endpointName).toEqual("events-renamed");
      const replacedObserved = yield* get("events-renamed");
      expect(replacedObserved.properties.TopicEndpoint).toEqual(
        updated.topic.endpoint,
      );
      expect(yield* waitGone(get(endpoint.endpointName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("events-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
