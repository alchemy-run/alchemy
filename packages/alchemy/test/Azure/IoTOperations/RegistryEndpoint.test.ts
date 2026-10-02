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

const getRegistryEndpoint = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetRegistryEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      registryEndpointName: name,
    });
  });

type Props = Omit<
  Azure.IoTOperations.RegistryEndpointProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.RegistryEndpoint(
      "RegistryEndpoint",
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
  "create, update, replace, and delete an IoT Operations RegistryEndpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({
          host: "ghcr.io",
          authentication: { method: "Anonymous", anonymousSettings: {} },
        }),
      );
      const get = (name: string) =>
        getRegistryEndpoint(
          group.resourceGroupName,
          instance.instanceName,
          name,
        );
      const observed = yield* get(resource.registryEndpointName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.host).toEqual("ghcr.io");

      // In place.
      const updated = yield* stack.deploy(
        program({
          host: "mcr.microsoft.com",
          authentication: { method: "Anonymous", anonymousSettings: {} },
        }),
      );
      expect(updated.resource.registryEndpointName).toEqual(
        resource.registryEndpointName,
      );
      const after = yield* get(resource.registryEndpointName);
      expect(after.properties?.host).toEqual("mcr.microsoft.com");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-registry",
          host: "mcr.microsoft.com",
          authentication: { method: "Anonymous", anonymousSettings: {} },
        }),
      );
      expect(replaced.resource.registryEndpointName).toEqual(
        "alchemy-registry",
      );
      expect(yield* waitGone(get(resource.registryEndpointName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-registry"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a RegistryEndpoint
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the RegistryEndpoint with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .RegistryEndpointCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          registryEndpointName: "probe",
          properties: {
            host: "ghcr.io",
            authentication: { method: "Anonymous", anonymousSettings: {} },
          },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getRegistryEndpoint(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
