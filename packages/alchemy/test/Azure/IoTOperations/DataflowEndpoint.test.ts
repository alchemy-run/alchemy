import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as iot from "@distilled.cloud/azure/iotoperations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  instanceStack,
  logLevel,
  missingCustomLocation,
  probeGroup,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDataflowEndpoint = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetDataflowEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      dataflowEndpointName: name,
    });
  });

type Props = Omit<
  Azure.IoTOperations.DataflowEndpointProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.DataflowEndpoint(
      "DataflowEndpoint",
      {
        resourceGroup: group.resourceGroupName,
        instanceName: instance.instanceName,
        ...props,
      },
    );
    return { group, instance, resource };
  });

// Needs an Arc-enabled cluster with IoT Operations (see util.ts); not
// creatable on the free trial. ~20-25 min (instance + child), cluster cost only.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an IoT Operations DataflowEndpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({
          endpointType: "LocalStorage",
          localStorageSettings: { persistentVolumeClaimRef: "alchemy-a" },
        }),
      );
      const get = (name: string) =>
        getDataflowEndpoint(
          group.resourceGroupName,
          instance.instanceName,
          name,
        );
      const observed = yield* get(resource.dataflowEndpointName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.localStorageSettings?.persistentVolumeClaimRef,
      ).toEqual("alchemy-a");

      // In place.
      const updated = yield* stack.deploy(
        program({
          endpointType: "LocalStorage",
          localStorageSettings: { persistentVolumeClaimRef: "alchemy-b" },
        }),
      );
      expect(updated.resource.dataflowEndpointName).toEqual(
        resource.dataflowEndpointName,
      );
      const after = yield* get(resource.dataflowEndpointName);
      expect(
        after.properties?.localStorageSettings?.persistentVolumeClaimRef,
      ).toEqual("alchemy-b");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-endpoint",
          endpointType: "LocalStorage",
          localStorageSettings: { persistentVolumeClaimRef: "alchemy-b" },
        }),
      );
      expect(replaced.resource.dataflowEndpointName).toEqual(
        "alchemy-endpoint",
      );
      expect(yield* waitGone(get(resource.dataflowEndpointName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-endpoint"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a DataflowEndpoint
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the DataflowEndpoint with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .DataflowEndpointCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          dataflowEndpointName: "probe",
          properties: {
            endpointType: "LocalStorage",
            localStorageSettings: { persistentVolumeClaimRef: "probe" },
          },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getDataflowEndpoint(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
