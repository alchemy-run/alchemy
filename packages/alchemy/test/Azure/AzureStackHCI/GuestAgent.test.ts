import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import { logLevel, tags, waitGone, withArcMachineRecord } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAgent = (machineId: string) =>
  hci.GetGuestAgent({ resourceUri: machineId });

// An Arc machine whose Azure Local VM instance already exists.
const vmMachineId = () => process.env.AZURE_TEST_HCI_VM_MACHINE ?? "";

const program = (action: "install" | "repair") =>
  Effect.gen(function* () {
    const agent = yield* Azure.AzureStackHCI.GuestAgent("Agent", {
      machineId: vmMachineId(),
      username: "azureuser",
      password: Redacted.make(process.env.AZURE_TEST_HCI_VM_PASSWORD ?? ""),
      provisioningAction: action,
    });
    return { agent };
  });

// Installs into a running Arc VM on a deployed Azure Local cluster
// (impossible on the free trial). Run with AZURE_TEST_PAID=1,
// AZURE_TEST_HCI_VM_MACHINE and AZURE_TEST_HCI_VM_PASSWORD.
test.provider.skipIf(!runPaidOnly)(
  "install, repair, and delete a guest agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { agent } = yield* stack.deploy(program("install"));
      expect(agent.provisioningAction).toEqual("install");
      expect(
        (yield* getAgent(vmMachineId())).properties.provisioningAction,
      ).toEqual("install");

      // In place: repair.
      const repaired = yield* stack.deploy(program("repair"));
      expect(repaired.agent.guestAgentId).toEqual(agent.guestAgentId);
      expect(
        (yield* getAgent(vmMachineId())).properties.provisioningAction,
      ).toEqual("repair");

      yield* stack.destroy();
      expect(yield* waitGone(getAgent(vmMachineId()))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): on a bare Arc machine record created out of band
// there is no VM instance, so the guest agent route is not found.
test.provider(
  "a guest agent needs an existing Arc VM",
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
      yield* withArcMachineRecord(group.resourceGroupName, (machineId) =>
        Effect.gen(function* () {
          const error = yield* hci
            .CreateGuestAgent({
              resourceUri: machineId,
              properties: { provisioningAction: "install" },
            })
            .pipe(Effect.flip);
          expect(error._tag).toEqual("NotFound");
          const getError = yield* getAgent(machineId).pipe(Effect.flip);
          expect(getError._tag).toEqual("NotFound");
        }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
