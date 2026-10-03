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

const getDataflow = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetDataflow({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      dataflowProfileName: "default",
      dataflowName: name,
    });
  });

// Routes broker topic `alchemy/in` to `alchemy/out` through the default
// (local broker) dataflow endpoint IoT Operations creates.
const OPERATIONS = [
  {
    operationType: "Source",
    sourceSettings: { endpointRef: "default", dataSources: ["alchemy/in"] },
  },
  {
    operationType: "Destination",
    destinationSettings: {
      endpointRef: "default",
      dataDestination: "alchemy/out",
    },
  },
];

type Props = Omit<
  Azure.IoTOperations.DataflowProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.Dataflow("Dataflow", {
      resourceGroup: group.resourceGroupName,
      instanceName: instance.instanceName,
      ...props,
    });
    return { group, instance, resource };
  });

// Needs an Arc-enabled cluster with IoT Operations (see util.ts); not
// creatable on the free trial. ~20-25 min (instance + child), cluster cost only.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an IoT Operations Dataflow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({ mode: "Enabled", operations: OPERATIONS }),
      );
      const get = (name: string) =>
        getDataflow(group.resourceGroupName, instance.instanceName, name);
      const observed = yield* get(resource.dataflowName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.mode).toEqual("Enabled");

      // In place.
      const updated = yield* stack.deploy(
        program({ mode: "Disabled", operations: OPERATIONS }),
      );
      expect(updated.resource.dataflowName).toEqual(resource.dataflowName);
      const after = yield* get(resource.dataflowName);
      expect(after.properties?.mode).toEqual("Disabled");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-dataflow",
          mode: "Disabled",
          operations: OPERATIONS,
        }),
      );
      expect(replaced.resource.dataflowName).toEqual("alchemy-dataflow");
      expect(yield* waitGone(get(resource.dataflowName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-dataflow"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a Dataflow
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the Dataflow with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .DataflowCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          dataflowProfileName: "default",
          dataflowName: "probe",
          properties: { operations: [] },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getDataflow(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
