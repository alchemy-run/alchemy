import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withVcpus } from "../gates.ts";
import {
  logLevel,
  PUBLIC_KEY_1,
  subscriptionId,
  tags,
  untilGone,
  VM_LOCATION,
  VM_SIZE,
  vmNetwork,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRunCommand = (
  resourceGroupName: string,
  vmName: string,
  runCommandName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineDiagnosticRunCommandByVirtualMachine({
      subscriptionId,
      resourceGroupName,
      vmName,
      runCommandName,
      _expand: "instanceView",
    }),
  );

// One 1-vCPU VM (~$0.04/hour) for ~10 minutes; diagnostic run commands are free.
const program = (props: {
  timeoutInSeconds: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, nic } = yield* vmNetwork();
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: VM_LOCATION,
      vmSize: VM_SIZE,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
    });
    const command = yield* Azure.Compute.VirtualMachineDiagnosticRunCommand(
      "Hello",
      {
        resourceGroup: group.resourceGroupName,
        virtualMachine: vm.virtualMachineName,
        // The only command IDs Azure accepts on this surface.
        commandId: "FleetDiagnosticsLinux",
        timeoutInSeconds: props.timeoutInSeconds,
        // FleetDiagnosticsLinux needs the Fleet Diagnostics agent, which a
        // stock Ubuntu image lacks (exit 127); keep the deploy green and
        // assert on the reported execution instead.
        treatFailureAsDeploymentFailure: false,
        tags: props.tags,
      },
    );
    return { group, vm, command };
  });

test.provider(
  "create, re-run, and delete a VM diagnostic run command",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, command } = yield* stack.deploy(
        program({ timeoutInSeconds: 600, tags: { env: "test" } }),
      );
      expect(command.provisioningState).toEqual("Succeeded");
      expect(command.executionState).toBeDefined();
      const observed = yield* getRunCommand(
        group.resourceGroupName,
        vm.virtualMachineName,
        command.runCommandName,
      );
      expect(observed.properties?.source?.commandId).toEqual(
        "FleetDiagnosticsLinux",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hello");

      // In place: a new timeout re-runs the command; new tags.
      const updated = yield* stack.deploy(
        program({ timeoutInSeconds: 900, tags: { env: "prod" } }),
      );
      expect(updated.command.runCommandId).toEqual(command.runCommandId);
      expect(updated.command.executionState).toBeDefined();
      const reobserved = yield* getRunCommand(
        group.resourceGroupName,
        vm.virtualMachineName,
        command.runCommandName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.timeoutInSeconds).toEqual(900);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRunCommand(
            group.resourceGroupName,
            vm.virtualMachineName,
            command.runCommandName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
