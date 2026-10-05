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

const getProfile = (
  resourceGroupName: string,
  assetEndpointProfileName: string,
) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetAssetEndpointProfile({
      subscriptionId: yield* subscription,
      resourceGroupName,
      assetEndpointProfileName,
    });
  });

const program = (props: {
  name?: string;
  targetAddress: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const profile = yield* Azure.DeviceRegistry.AssetEndpointProfile(
      "Profile",
      {
        resourceGroup: group.resourceGroupName,
        name: props.name,
        location,
        customLocationId: customLocationId(),
        targetAddress: props.targetAddress,
        endpointProfileType: "Microsoft.OpcUa",
        authentication: { method: "Anonymous" },
        tags: props.tags,
      },
    );
    return { group, profile };
  });

// Needs an Arc-connected Kubernetes cluster with Azure IoT Operations
// (AZURE_TEST_AIO_CUSTOM_LOCATION). The cluster (>= 4-8 vCPUs, ~$0.50+/hour)
// is beyond the free trial; the profile itself is free.
test.provider.skipIf(!runPaidOnly || !customLocationId())(
  "create, update, replace, and delete an asset endpoint profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, profile } = yield* stack.deploy(
        program({
          targetAddress: "opc.tcp://plc.example:4840",
          tags: { env: "a" },
        }),
      );
      const get = (name: string) => getProfile(group.resourceGroupName, name);
      const observed = yield* get(profile.assetEndpointProfileName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.targetAddress).toEqual(
        "opc.tcp://plc.example:4840",
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Profile");

      // In place: target address and tags.
      const updated = yield* stack.deploy(
        program({
          targetAddress: "opc.tcp://plc.example:4841",
          tags: { env: "b" },
        }),
      );
      expect(updated.profile.uuid).toEqual(profile.uuid);
      const afterUpdate = yield* get(profile.assetEndpointProfileName);
      expect(afterUpdate.properties?.targetAddress).toEqual(
        "opc.tcp://plc.example:4841",
      );
      expect(afterUpdate.tags?.env).toEqual("b");

      // Replacement: a new name.
      const newName = `${profile.assetEndpointProfileName.slice(0, 40)}-x`;
      const replaced = yield* stack.deploy(
        program({
          name: newName,
          targetAddress: "opc.tcp://plc.example:4841",
          tags: { env: "b" },
        }),
      );
      expect(replaced.profile.assetEndpointProfileName).toEqual(newName);
      expect(yield* waitGone(get(profile.assetEndpointProfileName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(newName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: without an IoT Operations custom location the trial gets
// the typed error.
test.provider(
  "an asset endpoint profile without a custom location fails with CustomLocationNotFound",
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
        .AssetEndpointProfilesCreateOrReplace({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          assetEndpointProfileName: "probe",
          location,
          extendedLocation: {
            type: "CustomLocation",
            name: missingCustomLocation(
              subscriptionId,
              group.resourceGroupName,
            ),
          },
          properties: {
            targetAddress: "opc.tcp://plc.example:4840",
            endpointProfileType: "Microsoft.OpcUa",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
