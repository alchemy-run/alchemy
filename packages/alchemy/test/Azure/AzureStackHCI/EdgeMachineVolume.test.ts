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

const getEdgeMachineVolume = (
  resourceGroupName: string,
  edgeMachineName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* hci.GetEdgeMachineVolume({
      subscriptionId: yield* subscription,
      resourceGroupName,
      edgeMachineName,
      volumeName: name,
    });
  });

const program = (props: { second: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: process.env.AZURE_TEST_HCI_LOCATION ?? "eastus",
    });
    const machine = yield* Azure.AzureStackHCI.EdgeMachine("Machine", {
      resourceGroup: group.resourceGroupName,
      arcMachineResourceId: arcMachineId(),
    });
    const child = yield* Azure.AzureStackHCI.EdgeMachineVolume("Child", {
      resourceGroup: group.resourceGroupName,
      edgeMachine: machine.edgeMachineName,
      name: props.second ? "data2" : "data1",
      volumeConfiguration: {},
    });
    return { group, machine, child };
  });

// Needs a claimed edge machine backed by an Arc-enabled server running
// Azure Local's OS (real hardware; the free trial has none). Run with
// AZURE_TEST_PAID=1 and AZURE_TEST_HCI_ARC_MACHINE.
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete an edge machine volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, machine, child } = yield* stack.deploy(
        program({ second: false }),
      );
      const get = (name: string) =>
        getEdgeMachineVolume(
          group.resourceGroupName,
          machine.edgeMachineName,
          name,
        );
      expect((yield* get(child.volumeName)).id).toEqual(child.volumeId);

      // Replacement: a different volume name.
      const replaced = yield* stack.deploy(program({ second: true }));
      expect(replaced.child.volumeName).not.toEqual(child.volumeName);
      expect(yield* waitGone(get(child.volumeName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.child.volumeName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, a resource group only): without a claimed edge
// machine (which needs real hardware) the parent is missing and the PUT
// fails with a not-found error.
test.provider(
  "an edge machine volume needs an existing edge machine",
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
        .EdgeMachineVolumesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          edgeMachineName: "missing",
          volumeName: "default",
          properties: { volumeConfiguration: {} },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("could not be found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
