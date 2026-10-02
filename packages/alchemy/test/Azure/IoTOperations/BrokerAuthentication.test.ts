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

const getBrokerAuthentication = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetBrokerAuthentication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      brokerName: "default",
      authenticationName: name,
    });
  });

type Props = Omit<
  Azure.IoTOperations.BrokerAuthenticationProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.BrokerAuthentication(
      "BrokerAuthentication",
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
  "create, update, replace, and delete an IoT Operations BrokerAuthentication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({
          authenticationMethods: [
            {
              method: "ServiceAccountToken",
              serviceAccountTokenSettings: { audiences: ["alchemy-a"] },
            },
          ],
        }),
      );
      const get = (name: string) =>
        getBrokerAuthentication(
          group.resourceGroupName,
          instance.instanceName,
          name,
        );
      const observed = yield* get(resource.authenticationName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.authenticationMethods[0]
          ?.serviceAccountTokenSettings?.audiences,
      ).toEqual(["alchemy-a"]);

      // In place.
      const updated = yield* stack.deploy(
        program({
          authenticationMethods: [
            {
              method: "ServiceAccountToken",
              serviceAccountTokenSettings: { audiences: ["alchemy-b"] },
            },
          ],
        }),
      );
      expect(updated.resource.authenticationName).toEqual(
        resource.authenticationName,
      );
      const after = yield* get(resource.authenticationName);
      expect(
        after.properties?.authenticationMethods[0]?.serviceAccountTokenSettings
          ?.audiences,
      ).toEqual(["alchemy-b"]);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-authn",
          authenticationMethods: [
            {
              method: "ServiceAccountToken",
              serviceAccountTokenSettings: { audiences: ["alchemy-b"] },
            },
          ],
        }),
      );
      expect(replaced.resource.authenticationName).toEqual("alchemy-authn");
      expect(yield* waitGone(get(resource.authenticationName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-authn"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a BrokerAuthentication
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the BrokerAuthentication with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .BrokerAuthenticationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          brokerName: "default",
          authenticationName: "probe",
          properties: { authenticationMethods: [] },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getBrokerAuthentication(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
