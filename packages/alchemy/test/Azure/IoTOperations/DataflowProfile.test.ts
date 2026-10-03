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

const getDataflowProfile = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetDataflowProfile({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      dataflowProfileName: name,
    });
  });

type Props = Omit<
  Azure.IoTOperations.DataflowProfileProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.DataflowProfile(
      "DataflowProfile",
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
  "create, update, replace, and delete an IoT Operations DataflowProfile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({ instanceCount: 1 }),
      );
      const get = (name: string) =>
        getDataflowProfile(
          group.resourceGroupName,
          instance.instanceName,
          name,
        );
      const observed = yield* get(resource.dataflowProfileName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.instanceCount).toEqual(1);

      // In place.
      const updated = yield* stack.deploy(program({ instanceCount: 2 }));
      expect(updated.resource.dataflowProfileName).toEqual(
        resource.dataflowProfileName,
      );
      const after = yield* get(resource.dataflowProfileName);
      expect(after.properties?.instanceCount).toEqual(2);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-profile", instanceCount: 2 }),
      );
      expect(replaced.resource.dataflowProfileName).toEqual("alchemy-profile");
      expect(yield* waitGone(get(resource.dataflowProfileName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-profile"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a DataflowProfile
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the DataflowProfile with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .DataflowProfileCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          dataflowProfileName: "probe",
          properties: { instanceCount: 1 },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getDataflowProfile(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
