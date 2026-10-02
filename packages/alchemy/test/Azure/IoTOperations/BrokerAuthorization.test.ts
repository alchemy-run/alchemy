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

const getBrokerAuthorization = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetBrokerAuthorization({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      brokerName: "default",
      authorizationName: name,
    });
  });

type Props = Omit<
  Azure.IoTOperations.BrokerAuthorizationProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.BrokerAuthorization(
      "BrokerAuthorization",
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
  "create, update, replace, and delete an IoT Operations BrokerAuthorization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({
          authorizationPolicies: {
            cache: "Enabled",
            rules: [
              {
                principals: { clientIds: ["sensor-*"] },
                brokerResources: [{ method: "Connect" }],
              },
            ],
          },
        }),
      );
      const get = (name: string) =>
        getBrokerAuthorization(
          group.resourceGroupName,
          instance.instanceName,
          name,
        );
      const observed = yield* get(resource.authorizationName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.authorizationPolicies.cache).toEqual(
        "Enabled",
      );

      // In place.
      const updated = yield* stack.deploy(
        program({
          authorizationPolicies: {
            cache: "Disabled",
            rules: [
              {
                principals: { clientIds: ["sensor-*"] },
                brokerResources: [{ method: "Connect" }],
              },
            ],
          },
        }),
      );
      expect(updated.resource.authorizationName).toEqual(
        resource.authorizationName,
      );
      const after = yield* get(resource.authorizationName);
      expect(after.properties?.authorizationPolicies.cache).toEqual("Disabled");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-authz",
          authorizationPolicies: {
            cache: "Disabled",
            rules: [
              {
                principals: { clientIds: ["sensor-*"] },
                brokerResources: [{ method: "Connect" }],
              },
            ],
          },
        }),
      );
      expect(replaced.resource.authorizationName).toEqual("alchemy-authz");
      expect(yield* waitGone(get(resource.authorizationName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-authz"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a BrokerAuthorization
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the BrokerAuthorization with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .BrokerAuthorizationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          brokerName: "default",
          authorizationName: "probe",
          properties: { authorizationPolicies: {} },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getBrokerAuthorization(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
