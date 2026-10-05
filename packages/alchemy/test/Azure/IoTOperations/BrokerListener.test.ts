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

const getBrokerListener = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetBrokerListener({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      brokerName: "default",
      listenerName: name,
    });
  });

type Props = Omit<
  Azure.IoTOperations.BrokerListenerProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.BrokerListener(
      "BrokerListener",
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
  "create, update, replace, and delete an IoT Operations BrokerListener",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({ serviceType: "ClusterIp", ports: [{ port: 1883 }] }),
      );
      const get = (name: string) =>
        getBrokerListener(group.resourceGroupName, instance.instanceName, name);
      const observed = yield* get(resource.listenerName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.ports[0]?.port).toEqual(1883);

      // In place.
      const updated = yield* stack.deploy(
        program({ serviceType: "ClusterIp", ports: [{ port: 1884 }] }),
      );
      expect(updated.resource.listenerName).toEqual(resource.listenerName);
      const after = yield* get(resource.listenerName);
      expect(after.properties?.ports[0]?.port).toEqual(1884);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-listener",
          serviceType: "ClusterIp",
          ports: [{ port: 1884 }],
        }),
      );
      expect(replaced.resource.listenerName).toEqual("alchemy-listener");
      expect(yield* waitGone(get(resource.listenerName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-listener"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a BrokerListener
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the BrokerListener with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .BrokerListenerCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          brokerName: "default",
          listenerName: "probe",
          properties: { ports: [{ port: 1883 }] },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getBrokerListener(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
