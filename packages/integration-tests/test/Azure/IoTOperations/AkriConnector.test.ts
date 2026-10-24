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

const getAkriConnector = (
  resourceGroupName: string,
  instanceName: string,
  templateName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* iot.GetAkriConnector({
      subscriptionId,
      resourceGroupName,
      instanceName,
      akriConnectorTemplateName: templateName,
      connectorName: name,
    });
  });

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
  Azure.IoTOperations.AkriConnectorProps,
  "resourceGroup" | "instanceName" | "akriConnectorTemplateName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const template = yield* Azure.IoTOperations.AkriConnectorTemplate("AkriConnectorTemplate", {
      resourceGroup: group.resourceGroupName,
      instanceName: instance.instanceName,
      deviceInboundEndpointTypes: [{ endpointType: "Microsoft.Rest" }],
      runtimeConfiguration: RUNTIME,
    });
    const resource = yield* Azure.IoTOperations.AkriConnector("AkriConnector", {
      resourceGroup: group.resourceGroupName,
      instanceName: instance.instanceName,
      akriConnectorTemplateName: template.akriConnectorTemplateName,
      ...props,
    });
    return { group, instance, template, resource };
  });

// Needs an Arc-enabled cluster with IoT Operations (see util.ts); not
// creatable on the free trial. ~20-25 min (instance + children), cluster cost only.
test.provider.skipIf(!runPaidOnly)(
  "create, redeploy, replace, and delete an IoT Operations AkriConnector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, template, resource } = yield* stack.deploy(program({}));
      const get = (name: string) =>
        getAkriConnector(
          group.resourceGroupName,
          instance.instanceName,
          template.akriConnectorTemplateName,
          name,
        );
      const observed = yield* get(resource.akriConnectorName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(resource.akriConnectorId.toLowerCase()).toEqual((observed.id ?? "").toLowerCase());

      // Redeploy: nothing is settable, so the connector stays as it is.
      const redeployed = yield* stack.deploy(program({}));
      expect(redeployed.resource.akriConnectorName).toEqual(resource.akriConnectorName);
      expect(redeployed.resource.akriConnectorId).toEqual(resource.akriConnectorId);

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(program({ name: "alchemy-connector" }));
      expect(replaced.resource.akriConnectorName).toEqual("alchemy-connector");
      expect(yield* waitGone(get(resource.akriConnectorName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-connector"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects an AkriConnector
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the AkriConnector with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .AkriConnectorCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          akriConnectorTemplateName: "probe",
          connectorName: "probe",
          properties: {},
          extendedLocation: missingCustomLocation(subscriptionId, group.resourceGroupName),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getAkriConnector(
        group.resourceGroupName,
        "probe",
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
