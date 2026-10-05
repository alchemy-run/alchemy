import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as iot from "@distilled.cloud/azure/iotoperations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  customLocationId,
  location,
  logLevel,
  missingCustomLocation,
  probeGroup,
  schemaRegistryId,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getInstance = (resourceGroupName: string, instanceName: string) =>
  Effect.gen(function* () {
    return yield* iot.GetInstance({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: location(),
    });
    const instance = yield* Azure.IoTOperations.Instance("Instance", {
      resourceGroup: group.resourceGroupName,
      location: location(),
      customLocationId: customLocationId(),
      schemaRegistryId: schemaRegistryId(),
      description: props.description,
      tags: props.tags,
      ...(props.name !== undefined ? { name: props.name } : {}),
    });
    return { group, instance };
  });

// Needs an Arc-enabled cluster with IoT Operations extensions (see
// util.ts); not creatable on the free trial. ~20 min, cluster cost only.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an IoT Operations Instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance } = yield* stack.deploy(
        program({ description: "a", tags: { env: "a" } }),
      );
      const get = (name: string) => getInstance(group.resourceGroupName, name);
      const observed = yield* get(instance.instanceName);
      expect(observed.properties?.description).toEqual("a");
      expect(observed.tags?.env).toEqual("a");
      expect(observed.extendedLocation.name.toLowerCase()).toEqual(
        customLocationId().toLowerCase(),
      );

      // In place: description (PUT) and tags (PATCH).
      const updated = yield* stack.deploy(
        program({ description: "b", tags: { env: "b" } }),
      );
      expect(updated.instance.instanceId).toEqual(instance.instanceId);
      const after = yield* get(instance.instanceName);
      expect(after.properties?.description).toEqual("b");
      expect(after.tags?.env).toEqual("b");

      // Replacement: an explicit name. A cluster hosts one instance, so
      // the old one is deleted first.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-aio", description: "b", tags: { env: "b" } }),
      );
      expect(replaced.instance.instanceName).toEqual("alchemy-aio");
      expect(yield* waitGone(get(instance.instanceName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-aio"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): without an Arc custom
// location the PUT is rejected with the typed error.
test.provider(
  "a missing custom location rejects the Instance with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .InstanceCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          location: "eastus",
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
          properties: {
            schemaRegistryRef: {
              resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.DeviceRegistry/schemaRegistries/missing`,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      const getError = yield* getInstance(
        group.resourceGroupName,
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");

      // Through the provider: reconcile observes nothing, PUTs, and
      // surfaces the same typed error; the child provider's PUT under the
      // missing instance surfaces the typed 404.
      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const instance = yield* Azure.IoTOperations.Instance("Instance", {
              resourceGroup: probe.group.resourceGroupName,
              location: "eastus",
              customLocationId: missingCustomLocation(
                subscriptionId,
                group.resourceGroupName,
              ).name,
              schemaRegistryId: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.DeviceRegistry/schemaRegistries/missing`,
            });
            return { instance };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("CustomLocationNotFound");
      const childError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const listener = yield* Azure.IoTOperations.BrokerListener(
              "Listener",
              {
                resourceGroup: probe.group.resourceGroupName,
                instanceName: "missing",
                ports: [{ port: 1883 }],
              },
            );
            return { listener };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(childError)).toContain("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
