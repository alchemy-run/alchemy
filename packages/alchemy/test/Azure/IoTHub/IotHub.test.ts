import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as iothub from "@distilled.cloud/azure/iothub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone, withFreeHub } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHub = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    return yield* iothub.GetIotHubResource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
    });
  });

const program = (props: {
  location: string;
  maxDeliveryCount: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const hub = yield* Azure.IoTHub.IotHub("Hub", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      sku: "F1",
      partitionCount: 2,
      cloudToDevice: { maxDeliveryCount: props.maxDeliveryCount },
      tags: props.tags,
    });
    return { group, hub };
  });

// F1 hub: free (one per subscription). Create ~2 min, delete ~1 min.
test.provider(
  "create, update, replace, and delete an IoT hub",
  (stack) =>
    withFreeHub(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, hub } = yield* stack.deploy(
          program({
            location: "eastus",
            maxDeliveryCount: 10,
            tags: { env: "test" },
          }),
        );
        expect(hub.sku).toEqual("F1");
        expect(hub.hostName).toEqual(`${hub.iotHubName}.azure-devices.net`);
        expect(hub.eventHubEndpoint).toMatch(/^sb:\/\//);
        expect(hub.partitionIds).toHaveLength(2);
        expect(hub.tags).toEqual({ env: "test" });
        expect(Redacted.value(hub.primaryConnectionString!)).toContain(
          "SharedAccessKeyName=iothubowner",
        );
        const observed = yield* getHub(group.resourceGroupName, hub.iotHubName);
        expect(observed.properties?.cloudToDevice?.maxDeliveryCount).toEqual(
          10,
        );
        expect(observed.tags?.["alchemy::id"]).toEqual("Hub");

        // In-place: cloud-to-device settings and tags.
        const updated = yield* stack.deploy(
          program({
            location: "eastus",
            maxDeliveryCount: 20,
            tags: { env: "test", team: "iot" },
          }),
        );
        expect(updated.hub.iotHubId).toEqual(hub.iotHubId);
        const afterUpdate = yield* getHub(
          group.resourceGroupName,
          hub.iotHubName,
        );
        expect(afterUpdate.properties?.cloudToDevice?.maxDeliveryCount).toEqual(
          20,
        );
        expect(afterUpdate.tags?.team).toEqual("iot");
        // Keys survive the full-document PUT.
        expect(Redacted.value(updated.hub.primaryKey!)).toEqual(
          Redacted.value(hub.primaryKey!),
        );

        // Replacement: location (F1 deletes the old hub first).
        const replaced = yield* stack.deploy(
          program({
            location: "westus2",
            maxDeliveryCount: 20,
            tags: { env: "test", team: "iot" },
          }),
        );
        expect(replaced.hub.location.toLowerCase()).toEqual("westus2");
        expect(replaced.hub.iotHubName).not.toEqual(hub.iotHubName);
        expect(
          yield* waitGone(getHub(group.resourceGroupName, hub.iotHubName)),
        ).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(
            getHub(group.resourceGroupName, replaced.hub.iotHubName),
          ),
        ).toEqual("gone");
      }).pipe(logLevel),
    ),
  { tags, timeout: 900_000 },
);
