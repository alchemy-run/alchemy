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

const getAkriConnectorTemplate = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetAkriConnectorTemplate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      akriConnectorTemplateName: name,
    });
  });

const ENDPOINT_TYPES = [{ endpointType: "Microsoft.Rest" }];
// The REST connector image from Microsoft Container Registry.
const RUNTIME = {
  runtimeConfigurationType: "ManagedConfiguration",
  managedConfigurationSettings: {
    managedConfigurationType: "ImageConfiguration",
    imageConfigurationSettings: {
      imageName: "azureiotoperations/akri-connectors/rest",
      registrySettings: {
        registrySettingsType: "ContainerRegistry",
        containerRegistrySettings: { registry: "mcr.microsoft.com" },
      },
      tagDigestSettings: { tagDigestType: "Tag", tag: "1.0.0" },
    },
  },
};

type Props = Omit<
  Azure.IoTOperations.AkriConnectorTemplateProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.AkriConnectorTemplate(
      "AkriConnectorTemplate",
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
  "create, update, replace, and delete an IoT Operations AkriConnectorTemplate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({
          diagnostics: { logs: { level: "info" } },
          deviceInboundEndpointTypes: ENDPOINT_TYPES,
          runtimeConfiguration: RUNTIME,
        }),
      );
      const get = (name: string) =>
        getAkriConnectorTemplate(
          group.resourceGroupName,
          instance.instanceName,
          name,
        );
      const observed = yield* get(resource.akriConnectorTemplateName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.diagnostics?.logs.level).toEqual("info");

      // In place.
      const updated = yield* stack.deploy(
        program({
          diagnostics: { logs: { level: "debug" } },
          deviceInboundEndpointTypes: ENDPOINT_TYPES,
          runtimeConfiguration: RUNTIME,
        }),
      );
      expect(updated.resource.akriConnectorTemplateName).toEqual(
        resource.akriConnectorTemplateName,
      );
      const after = yield* get(resource.akriConnectorTemplateName);
      expect(after.properties?.diagnostics?.logs.level).toEqual("debug");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-connector",
          diagnostics: { logs: { level: "debug" } },
          deviceInboundEndpointTypes: ENDPOINT_TYPES,
          runtimeConfiguration: RUNTIME,
        }),
      );
      expect(replaced.resource.akriConnectorTemplateName).toEqual(
        "alchemy-connector",
      );
      expect(yield* waitGone(get(resource.akriConnectorTemplateName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-connector"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a AkriConnectorTemplate
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the AkriConnectorTemplate with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .AkriConnectorTemplateCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          akriConnectorTemplateName: "probe",
          properties: {
            deviceInboundEndpointTypes: ENDPOINT_TYPES,
            runtimeConfiguration: RUNTIME,
          },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getAkriConnectorTemplate(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
