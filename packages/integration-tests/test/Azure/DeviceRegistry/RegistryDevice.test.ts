import * as Azure from "@alchemy.run/azure";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, registryLocation as location, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDevice = (resourceGroupName: string, namespaceName: string, registryDeviceName: string) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetRegistryDevice({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      registryDeviceName,
    });
  });

const program = (props: {
  externalDeviceId: string;
  enabled: boolean;
  softwareRevision: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const namespace = yield* Azure.DeviceRegistry.Namespace("Namespace", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const device = yield* Azure.DeviceRegistry.RegistryDevice("Device", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      externalDeviceId: props.externalDeviceId,
      manufacturer: "Contoso",
      model: "S-100",
      hardwareRevision: "A",
      softwareRevision: props.softwareRevision,
      enabled: props.enabled,
      tags: props.tags,
    });
    return { group, namespace, device };
  });

// Registry devices in a Device Registry namespace are free; each step
// provisions in well under a minute.
test.provider(
  "create, update, replace, and delete a registry device",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, device } = yield* stack.deploy(
        program({
          externalDeviceId: "sn-0001",
          enabled: true,
          softwareRevision: "1.0",
          tags: { env: "a" },
        }),
      );
      const get = (name: string) =>
        getDevice(group.resourceGroupName, namespace.namespaceName, name);
      const observed = yield* get(device.registryDeviceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.enablementState).toEqual("Enabled");
      expect(observed.properties?.externalDeviceId).toEqual("sn-0001");
      expect(observed.properties?.manufacturer).toEqual("Contoso");
      expect(observed.properties?.model).toEqual("S-100");
      expect(observed.properties?.hardwareRevision).toEqual("A");
      expect(observed.properties?.softwareRevision).toEqual("1.0");
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("Device");
      expect(device.location).toEqual(location);
      expect(device.uuid).toMatch(/^[0-9a-f-]{36}$/i);

      // In place: enablement, software revision, tags.
      const updated = yield* stack.deploy(
        program({
          externalDeviceId: "sn-0001",
          enabled: false,
          softwareRevision: "2.0",
          tags: { env: "b" },
        }),
      );
      expect(updated.device.registryDeviceId).toEqual(device.registryDeviceId);
      expect(updated.device.uuid).toEqual(device.uuid);
      expect(updated.device.enabled).toEqual(false);
      const afterUpdate = yield* get(device.registryDeviceName);
      expect(afterUpdate.properties?.enablementState).toEqual("Disabled");
      expect(afterUpdate.properties?.softwareRevision).toEqual("2.0");
      expect(afterUpdate.tags?.env).toEqual("b");

      // Replacement: the external device ID can only be set at creation.
      const replaced = yield* stack.deploy(
        program({
          externalDeviceId: "sn-0002",
          enabled: false,
          softwareRevision: "2.0",
          tags: { env: "b" },
        }),
      );
      expect(replaced.device.uuid).not.toEqual(device.uuid);
      const afterReplace = yield* get(replaced.device.registryDeviceName);
      expect(afterReplace.properties?.externalDeviceId).toEqual("sn-0002");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.device.registryDeviceName))).toEqual("gone");
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
