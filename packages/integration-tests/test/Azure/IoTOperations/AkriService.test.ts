import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as iot from "@distilled.cloud/azure/iotoperations";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
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

const getAkriService = (resourceGroupName: string, instanceName: string, name: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* iot.GetAkriService({
      subscriptionId,
      resourceGroupName,
      instanceName,
      akriServiceName: name,
    });
  });

type Props = Omit<Azure.IoTOperations.AkriServiceProps, "resourceGroup" | "instanceName">;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.AkriService("AkriService", {
      resourceGroup: group.resourceGroupName,
      instanceName: instance.instanceName,
      ...props,
    });
    return { group, instance, resource };
  });

// Needs an Arc-enabled cluster with IoT Operations (see util.ts); not
// creatable on the free trial. ~20-25 min (instance + child), cluster cost only.
test.provider.skipIf(!runPaidOnly)(
  "create, redeploy, replace, and delete an IoT Operations AkriService",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(program({}));
      const get = (name: string) => getAkriService(group.resourceGroupName, instance.instanceName, name);
      const observed = yield* get(resource.akriServiceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(resource.akriServiceId.toLowerCase()).toEqual((observed.id ?? "").toLowerCase());

      // Redeploy: nothing is settable, so the service stays as it is.
      const redeployed = yield* stack.deploy(program({}));
      expect(redeployed.resource.akriServiceName).toEqual(resource.akriServiceName);
      expect(redeployed.resource.akriServiceId).toEqual(resource.akriServiceId);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(program({ name: "alchemy-akri" }));
      expect(replaced.resource.akriServiceName).toEqual("alchemy-akri");
      expect(yield* waitGone(get(resource.akriServiceName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-akri"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects an AkriService
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the AkriService with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .AkriServiceCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          akriServiceName: "probe",
          properties: {},
          extendedLocation: missingCustomLocation(subscriptionId, group.resourceGroupName),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getAkriService(group.resourceGroupName, "probe", "probe").pipe(
        Effect.flip,
      );
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
