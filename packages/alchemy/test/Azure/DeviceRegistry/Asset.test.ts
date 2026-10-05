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

const getAsset = (resourceGroupName: string, assetName: string) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetAsset({
      subscriptionId: yield* subscription,
      resourceGroupName,
      assetName,
    });
  });

const program = (props: {
  profile: "Primary" | "Secondary";
  displayName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    // Both profiles stay deployed across the replacement step.
    const primary = yield* Azure.DeviceRegistry.AssetEndpointProfile(
      "Primary",
      {
        resourceGroup: group.resourceGroupName,
        location,
        customLocationId: customLocationId(),
        targetAddress: "opc.tcp://plc.example:4840",
        endpointProfileType: "Microsoft.OpcUa",
      },
    );
    const secondary = yield* Azure.DeviceRegistry.AssetEndpointProfile(
      "Secondary",
      {
        resourceGroup: group.resourceGroupName,
        location,
        customLocationId: customLocationId(),
        targetAddress: "opc.tcp://plc.example:4841",
        endpointProfileType: "Microsoft.OpcUa",
      },
    );
    const profile = props.profile === "Primary" ? primary : secondary;
    const asset = yield* Azure.DeviceRegistry.Asset("Asset", {
      resourceGroup: group.resourceGroupName,
      location,
      customLocationId: customLocationId(),
      assetEndpointProfile: profile.assetEndpointProfileName,
      displayName: props.displayName,
      datasets: [
        {
          name: "telemetry",
          dataPoints: [{ name: "temperature", dataSource: "ns=3;s=Temp" }],
        },
      ],
      tags: props.tags,
    });
    return { group, primary, secondary, asset };
  });

// Needs an Arc-connected Kubernetes cluster with Azure IoT Operations
// (AZURE_TEST_AIO_CUSTOM_LOCATION). The cluster (>= 4-8 vCPUs, ~$0.50+/hour)
// is beyond the free trial; the asset itself is free.
test.provider.skipIf(!runPaidOnly || !customLocationId())(
  "create, update, replace, and delete an asset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, primary, asset } = yield* stack.deploy(
        program({
          profile: "Primary",
          displayName: "Oven",
          tags: { env: "a" },
        }),
      );
      const get = (name: string) => getAsset(group.resourceGroupName, name);
      const observed = yield* get(asset.assetName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.assetEndpointProfileRef).toEqual(
        primary.assetEndpointProfileName,
      );
      expect(observed.properties?.displayName).toEqual("Oven");
      expect(observed.tags?.["alchemy::id"]).toEqual("Asset");

      // In place: display name and tags.
      const updated = yield* stack.deploy(
        program({
          profile: "Primary",
          displayName: "Oven 2",
          tags: { env: "b" },
        }),
      );
      expect(updated.asset.uuid).toEqual(asset.uuid);
      const afterUpdate = yield* get(asset.assetName);
      expect(afterUpdate.properties?.displayName).toEqual("Oven 2");
      expect(afterUpdate.tags?.env).toEqual("b");

      // Replacement: the endpoint profile reference is immutable.
      const replaced = yield* stack.deploy(
        program({
          profile: "Secondary",
          displayName: "Oven 2",
          tags: { env: "b" },
        }),
      );
      expect(replaced.asset.uuid).not.toEqual(asset.uuid);
      expect(
        (yield* get(replaced.asset.assetName)).properties
          ?.assetEndpointProfileRef,
      ).toEqual(replaced.secondary.assetEndpointProfileName);

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.asset.assetName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: without an IoT Operations custom location the trial gets
// the typed error.
test.provider(
  "an asset without a custom location fails with CustomLocationNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const error = yield* deviceregistry
        .AssetsCreateOrReplace({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          assetName: "probe",
          location,
          extendedLocation: {
            type: "CustomLocation",
            name: missingCustomLocation(
              subscriptionId,
              group.resourceGroupName,
            ),
          },
          properties: { assetEndpointProfileRef: "probe" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
