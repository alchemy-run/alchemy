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

const getDataflowGraph = (
  resourceGroupName: string,
  instanceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* iot.GetDataflowGraph({
      subscriptionId: yield* subscription,
      resourceGroupName,
      instanceName,
      dataflowProfileName: "default",
      dataflowGraphName: name,
    });
  });

// Source -> destination over the default (local broker) endpoint.
const NODES = [
  {
    name: "source",
    nodeType: "Source",
    sourceSettings: { endpointRef: "default", dataSources: ["alchemy/in"] },
  },
  {
    name: "sink",
    nodeType: "Destination",
    destinationSettings: {
      endpointRef: "default",
      dataDestination: "alchemy/out",
    },
  },
];
const CONNECTIONS = [{ from: { name: "source" }, to: { name: "sink" } }];

type Props = Omit<
  Azure.IoTOperations.DataflowGraphProps,
  "resourceGroup" | "instanceName"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const { group, instance } = yield* instanceStack;
    const resource = yield* Azure.IoTOperations.DataflowGraph("DataflowGraph", {
      resourceGroup: group.resourceGroupName,
      instanceName: instance.instanceName,
      ...props,
    });
    return { group, instance, resource };
  });

// Needs an Arc-enabled cluster with IoT Operations (see util.ts); not
// creatable on the free trial. ~20-25 min (instance + child), cluster cost only.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an IoT Operations DataflowGraph",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, instance, resource } = yield* stack.deploy(
        program({
          mode: "Enabled",
          nodes: NODES,
          nodeConnections: CONNECTIONS,
        }),
      );
      const get = (name: string) =>
        getDataflowGraph(group.resourceGroupName, instance.instanceName, name);
      const observed = yield* get(resource.dataflowGraphName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.mode).toEqual("Enabled");

      // In place.
      const updated = yield* stack.deploy(
        program({
          mode: "Disabled",
          nodes: NODES,
          nodeConnections: CONNECTIONS,
        }),
      );
      expect(updated.resource.dataflowGraphName).toEqual(
        resource.dataflowGraphName,
      );
      const after = yield* get(resource.dataflowGraphName);
      expect(after.properties?.mode).toEqual("Disabled");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-graph",
          mode: "Disabled",
          nodes: NODES,
          nodeConnections: CONNECTIONS,
        }),
      );
      expect(replaced.resource.dataflowGraphName).toEqual("alchemy-graph");
      expect(yield* waitGone(get(resource.dataflowGraphName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-graph"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): ARM rejects a DataflowGraph
// under a missing IoT Operations instance with the typed 404.
test.provider(
  "a missing parent instance rejects the DataflowGraph with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.IoTOperations");
      const error = yield* iot
        .DataflowGraphCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          instanceName: "probe",
          dataflowProfileName: "default",
          dataflowGraphName: "probe",
          properties: { nodes: [], nodeConnections: [] },
          extendedLocation: missingCustomLocation(
            subscriptionId,
            group.resourceGroupName,
          ),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");
      const getError = yield* getDataflowGraph(
        group.resourceGroupName,
        "probe",
        "probe",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
