import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEventHub = (
  resourceGroupName: string,
  namespaceName: string,
  eventHubName: string,
) =>
  Effect.gen(function* () {
    return yield* eventhub.GetEventHub({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      eventHubName,
    });
  });

const program = (props: {
  partitionCount: number;
  status: Azure.EventHub.EventHubStatus;
  userMetadata: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Basic",
    });
    const hub = yield* Azure.EventHub.EventHub("Orders", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      partitionCount: props.partitionCount,
      messageRetentionInDays: 1,
      status: props.status,
      userMetadata: props.userMetadata,
    });
    return { group, namespace, hub };
  });

// Basic namespace (~$0.015/hour) for a few minutes: well under $0.05.
test.provider(
  "create, update, replace, and delete an event hub",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, hub } = yield* stack.deploy(
        program({ partitionCount: 2, status: "Active", userMetadata: "v1" }),
      );
      expect(hub.partitionCount).toEqual(2);
      expect(hub.partitionIds).toEqual(["0", "1"]);
      expect(hub.status).toEqual("Active");
      expect(hub.userMetadata).toEqual("v1");

      const observed = yield* getEventHub(
        group.resourceGroupName,
        namespace.namespaceName,
        hub.eventHubName,
      );
      expect(observed.properties?.partitionCount).toEqual(2);
      expect(observed.properties?.messageRetentionInDays).toEqual(1);
      expect(observed.properties?.userMetadata).toMatch(
        /^v1 \[alchemy .+\/Orders\]$/,
      );

      // In-place: status and user metadata.
      const updated = yield* stack.deploy(
        program({
          partitionCount: 2,
          status: "SendDisabled",
          userMetadata: "v2",
        }),
      );
      expect(updated.hub.eventHubName).toEqual(hub.eventHubName);
      expect(updated.hub.eventHubId).toEqual(hub.eventHubId);
      const reobserved = yield* getEventHub(
        group.resourceGroupName,
        namespace.namespaceName,
        hub.eventHubName,
      );
      expect(reobserved.properties?.status).toEqual("SendDisabled");
      expect(reobserved.properties?.userMetadata).toMatch(/^v2 \[alchemy /);

      // Replacement: partitions cannot change on a Basic namespace.
      const replaced = yield* stack.deploy(
        program({
          partitionCount: 3,
          status: "SendDisabled",
          userMetadata: "v2",
        }),
      );
      expect(replaced.hub.eventHubName).not.toEqual(hub.eventHubName);
      expect(replaced.hub.partitionCount).toEqual(3);
      expect(
        yield* waitGone(
          getEventHub(
            group.resourceGroupName,
            namespace.namespaceName,
            hub.eventHubName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getEventHub(
            group.resourceGroupName,
            namespace.namespaceName,
            replaced.hub.eventHubName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
