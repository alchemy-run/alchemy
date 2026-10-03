import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  customLocationId,
  location,
  logLevel,
  missingCustomLocation,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAsset = (
  resourceGroupName: string,
  namespaceName: string,
  assetName: string,
) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetNamespaceAsset({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      assetName,
    });
  });

const program = (props: {
  displayName: string;
  endpoint: "opcua" | "opcua2";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const namespace = yield* Azure.DeviceRegistry.Namespace("Namespace", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    // Both endpoints stay on the device across the replacement step.
    const device = yield* Azure.DeviceRegistry.NamespaceDevice("Device", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      customLocationId: customLocationId(),
      endpoints: {
        inbound: {
          opcua: {
            endpointType: "Microsoft.OpcUa",
            address: "opc.tcp://plc.example:4840",
          },
          opcua2: {
            endpointType: "Microsoft.OpcUa",
            address: "opc.tcp://plc.example:4841",
          },
        },
      },
    });
    const asset = yield* Azure.DeviceRegistry.NamespaceAsset("Asset", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      customLocationId: customLocationId(),
      device: device.deviceName,
      deviceEndpoint: props.endpoint,
      displayName: props.displayName,
      datasets: [
        {
          name: "telemetry",
          dataPoints: [{ name: "temperature", dataSource: "ns=3;s=Temp" }],
        },
      ],
      tags: props.tags,
    });
    return { group, namespace, device, asset };
  });

// Needs an Arc-connected Kubernetes cluster with Azure IoT Operations
// (AZURE_TEST_AIO_CUSTOM_LOCATION). The cluster (>= 4-8 vCPUs, ~$0.50+/hour)
// is beyond the free trial; the asset itself is free.
test.provider.skipIf(!runPaidOnly || !customLocationId())(
  "create, update, replace, and delete a namespace asset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, asset } = yield* stack.deploy(
        program({ displayName: "Oven", endpoint: "opcua", tags: { env: "a" } }),
      );
      const get = (name: string) =>
        getAsset(group.resourceGroupName, namespace.namespaceName, name);
      const observed = yield* get(asset.assetName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.displayName).toEqual("Oven");
      expect(observed.properties?.deviceRef.endpointName).toEqual("opcua");
      expect(observed.tags?.["alchemy::id"]).toEqual("Asset");

      // In place: display name and tags.
      const updated = yield* stack.deploy(
        program({
          displayName: "Oven 2",
          endpoint: "opcua",
          tags: { env: "b" },
        }),
      );
      expect(updated.asset.uuid).toEqual(asset.uuid);
      const afterUpdate = yield* get(asset.assetName);
      expect(afterUpdate.properties?.displayName).toEqual("Oven 2");
      expect(afterUpdate.tags?.env).toEqual("b");

      // Replacement: the device endpoint is immutable.
      const replaced = yield* stack.deploy(
        program({
          displayName: "Oven 2",
          endpoint: "opcua2",
          tags: { env: "b" },
        }),
      );
      expect(replaced.asset.uuid).not.toEqual(asset.uuid);
      expect(
        (yield* get(replaced.asset.assetName)).properties?.deviceRef
          .endpointName,
      ).toEqual("opcua2");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.asset.assetName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: without an IoT Operations custom location the trial gets
// the typed error.
test.provider(
  "a namespace asset without a custom location fails with CustomLocationNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          const namespace = yield* Azure.DeviceRegistry.Namespace("Namespace", {
            resourceGroup: group.resourceGroupName,
            location,
          });
          return { group, namespace };
        }),
      );
      const subscriptionId = yield* subscription;
      const error = yield* deviceregistry
        .NamespaceAssetsCreateOrReplace({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          namespaceName: namespace.namespaceName,
          assetName: "probe",
          location,
          extendedLocation: {
            type: "CustomLocation",
            name: missingCustomLocation(
              subscriptionId,
              group.resourceGroupName,
            ),
          },
          properties: {
            deviceRef: { deviceName: "probe", endpointName: "opcua" },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
