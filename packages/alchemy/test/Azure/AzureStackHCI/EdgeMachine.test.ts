import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  arcMachineId,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMachine = (resourceGroupName: string, edgeMachineName: string) =>
  Effect.gen(function* () {
    return yield* hci.GetEdgeMachine({
      subscriptionId: yield* subscription,
      resourceGroupName,
      edgeMachineName,
    });
  });

const program = (props: {
  kind: "Standard" | "Dedicated";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: process.env.AZURE_TEST_HCI_LOCATION ?? "eastus",
    });
    const machine = yield* Azure.AzureStackHCI.EdgeMachine("Machine", {
      resourceGroup: group.resourceGroupName,
      edgeMachineKind: props.kind,
      arcMachineResourceId: arcMachineId(),
      tags: props.tags,
    });
    return { group, machine };
  });

// Needs an Arc-enabled server running Azure Local's OS (real hardware; the
// free trial has none). Run with AZURE_TEST_PAID=1 and
// AZURE_TEST_HCI_ARC_MACHINE.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an edge machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, machine } = yield* stack.deploy(
        program({ kind: "Standard", tags: { env: "a" } }),
      );
      const get = (name: string) => getMachine(group.resourceGroupName, name);
      expect((yield* get(machine.edgeMachineName)).tags?.env).toEqual("a");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ kind: "Standard", tags: { env: "b" } }),
      );
      expect(updated.machine.edgeMachineId).toEqual(machine.edgeMachineId);
      expect((yield* get(machine.edgeMachineName)).tags?.env).toEqual("b");

      // Replacement: the machine kind is immutable.
      const replaced = yield* stack.deploy(
        program({ kind: "Dedicated", tags: { env: "b" } }),
      );
      expect(replaced.machine.edgeMachineName).not.toEqual(
        machine.edgeMachineName,
      );
      expect(yield* waitGone(get(machine.edgeMachineName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.machine.edgeMachineName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): without an Azure Local Arc
// machine Azure cannot validate the OS SKU and rejects the edge machine.
test.provider(
  "an edge machine without an Azure Local Arc machine is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* hci
        .EdgeMachinesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          edgeMachineName: "probe",
          location: "eastus",
          identity: { type: "SystemAssigned" },
          properties: { edgeMachineKind: "Standard" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AzureLocalArcMachineRequired");
      const getError = yield* getMachine(group.resourceGroupName, "probe").pipe(
        Effect.flip,
      );
      expect(getError._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
