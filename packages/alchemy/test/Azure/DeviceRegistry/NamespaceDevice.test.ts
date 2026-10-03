import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDevice = (
  resourceGroupName: string,
  namespaceName: string,
  deviceName: string,
) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetNamespaceDevice({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      deviceName,
    });
  });

const program = (props: {
  model: string;
  enabled: boolean;
  operatingSystemVersion: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const namespace = yield* Azure.DeviceRegistry.Namespace("Namespace", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const device = yield* Azure.DeviceRegistry.NamespaceDevice("Device", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      manufacturer: "Contoso",
      model: props.model,
      operatingSystem: "Linux",
      operatingSystemVersion: props.operatingSystemVersion,
      enabled: props.enabled,
      attributes: { floor: "1" },
      tags: props.tags,
    });
    return { group, namespace, device };
  });

// Cloud-only devices in a Device Registry namespace are free (preview);
// each step provisions in well under a minute.
test.provider(
  "create, update, replace, and delete a namespace device",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, device } = yield* stack.deploy(
        program({
          model: "T-1000",
          enabled: false,
          operatingSystemVersion: "1.0",
          tags: { env: "a" },
        }),
      );
      const get = (name: string) =>
        getDevice(group.resourceGroupName, namespace.namespaceName, name);
      const observed = yield* get(device.deviceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.manufacturer).toEqual("Contoso");
      expect(observed.properties?.model).toEqual("T-1000");
      expect(observed.properties?.enabled).toEqual(false);
      expect(observed.properties?.attributes?.floor).toEqual("1");
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("Device");
      expect(device.location).toEqual(location);
      expect(device.uuid).toBeDefined();

      // In place: enabled, OS version, tags.
      const updated = yield* stack.deploy(
        program({
          model: "T-1000",
          enabled: true,
          operatingSystemVersion: "2.0",
          tags: { env: "b" },
        }),
      );
      expect(updated.device.deviceId).toEqual(device.deviceId);
      expect(updated.device.uuid).toEqual(device.uuid);
      const afterUpdate = yield* get(device.deviceName);
      expect(afterUpdate.properties?.enabled).toEqual(true);
      expect(afterUpdate.properties?.operatingSystemVersion).toEqual("2.0");
      expect(afterUpdate.tags?.env).toEqual("b");

      // Replacement: the model can only be set at creation.
      const replaced = yield* stack.deploy(
        program({
          model: "T-2000",
          enabled: true,
          operatingSystemVersion: "2.0",
          tags: { env: "b" },
        }),
      );
      expect(replaced.device.uuid).not.toEqual(device.uuid);
      expect(
        (yield* get(replaced.device.deviceName)).properties?.model,
      ).toEqual("T-2000");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.device.deviceName))).toEqual("gone");
      expect(
        yield* waitGone(
          Effect.gen(function* () {
            return yield* deviceregistry.GetNamespace({
              subscriptionId: yield* subscription,
              resourceGroupName: group.resourceGroupName,
              namespaceName: namespace.namespaceName,
            });
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
