import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm.ts";
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

const getBroker = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetBroker({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      brokerName: name,
    });
  });

type Props = Omit<
  Azure.IoTOperations.BrokerProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.Broker("Broker", {
      resourceGroup: group.resourceGroupName,
      instanceName: instance.instanceName,
      ...props,
    });
    return { group, instance, resource };
  });

// Needs an Arc-enabled cluster with IoT Operations (see util.ts); not
// creatable on the free trial. ~20-25 min (instance + child), cluster cost only.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an IoT Operations Broker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({
          diagnostics: { logs: { level: "info" } },
          memoryProfile: "Tiny",
        }),
      );
      const get = (name: string) =>
        getBroker(group.resourceGroupName, instance.instanceName, name);
      const observed = yield* get(resource.brokerName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.diagnostics?.logs?.level).toEqual("info");

      // In place.
      const updated = yield* stack.deploy(
        program({
          diagnostics: { logs: { level: "debug" } },
          memoryProfile: "Tiny",
        }),
      );
      expect(updated.resource.brokerName).toEqual(resource.brokerName);
      const after = yield* get(resource.brokerName);
      expect(after.properties?.diagnostics?.logs?.level).toEqual("debug");

      // Replacement: memoryProfile (immutable; the default broker keeps its name, so the old one is deleted first).
      const replaced = yield* stack.deploy(
        program({
          diagnostics: { logs: { level: "debug" } },
          memoryProfile: "Low",
        }),
      );
      expect(replaced.resource.brokerName).toEqual(resource.brokerName);
      expect(
        (yield* get(resource.brokerName)).properties?.memoryProfile,
      ).toEqual("Low");

      yield* stack.destroy();
      expect(yield* waitGone(get(resource.brokerName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a Broker
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the Broker with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .BrokerCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          brokerName: "probe",
          properties: { memoryProfile: "Tiny" },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getBroker(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
