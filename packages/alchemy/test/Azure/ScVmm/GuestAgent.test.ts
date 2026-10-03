import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as scvmm from "@distilled.cloud/azure/scvmm";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  logLevel,
  subscription,
  tags,
  waitGone,
  withArcMachineRecord,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAgent = (machineId: string) =>
  scvmm.GetGuestAgent({ resourceUri: machineId });

// An Arc machine whose SCVMM VM instance already exists and runs.
const vmMachineId = () => process.env.AZURE_TEST_SCVMM_VM_MACHINE ?? "";

const program = (action: "install" | "repair") =>
  Effect.gen(function* () {
    const agent = yield* Azure.ScVmm.GuestAgent("Agent", {
      machineId: vmMachineId(),
      username: "Administrator",
      password: Redacted.make(process.env.AZURE_TEST_SCVMM_VM_PASSWORD ?? ""),
      provisioningAction: action,
    });
    return { agent };
  });

// Installs into a running VM on an on-premises SCVMM behind an Arc resource
// bridge (impossible on the free trial). Run with AZURE_TEST_PAID=1,
// AZURE_TEST_SCVMM_VM_MACHINE and AZURE_TEST_SCVMM_VM_PASSWORD.
test.provider.skipIf(!runPaidOnly)(
  "install, repair, and delete an SCVMM guest agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { agent } = yield* stack.deploy(program("install"));
      expect(agent.provisioningAction).toEqual("install");
      expect(
        (yield* getAgent(vmMachineId())).properties?.provisioningAction,
      ).toEqual("install");

      // In place: repair.
      const repaired = yield* stack.deploy(program("repair"));
      expect(repaired.agent.guestAgentId).toEqual(agent.guestAgentId);
      expect(
        (yield* getAgent(vmMachineId())).properties?.provisioningAction,
      ).toEqual("repair");

      yield* stack.destroy();
      expect(yield* waitGone(getAgent(vmMachineId()))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): on a bare Arc machine record created out of band
// there is no VM instance, so the guest agent cannot be created or read.
test.provider(
  "an SCVMM guest agent needs an existing VM instance",
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
      yield* ensureRegistered(yield* subscription, "Microsoft.ScVmm");
      yield* withArcMachineRecord(group.resourceGroupName, (machineId) =>
        Effect.gen(function* () {
          const error = yield* scvmm
            .CreateGuestAgent({
              resourceUri: machineId,
              properties: { provisioningAction: "install" },
            })
            .pipe(Effect.flip);
          expect(error._tag).toEqual("ScVmmVmInstanceMissing");
          const getError = yield* getAgent(machineId).pipe(Effect.flip);
          expect(getError._tag).toEqual("ResourceNotFound");
        }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
