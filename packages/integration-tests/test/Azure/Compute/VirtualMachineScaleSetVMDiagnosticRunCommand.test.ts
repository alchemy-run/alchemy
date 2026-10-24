import * as Azure from "@alchemy.run/azure";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { withVcpus } from "../gates.ts";
import { logLevel, subscriptionId, tags, uniformScaleSet, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRunCommand = (resourceGroupName: string, vmScaleSetName: string, runCommandName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetVirtualMachineScaleSetVMDiagnosticRunCommand({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
      instanceId: "0",
      runCommandName,
      _expand: "instanceView",
    }),
  );

// One 1-vCPU scale set instance (~$0.04/hour) for ~12 minutes; diagnostic
// run commands are free.
const program = (props: { timeoutInSeconds: number; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, scaleSet } = yield* uniformScaleSet;
    const command = yield* Azure.Compute.VirtualMachineScaleSetVMDiagnosticRunCommand("Diag", {
      resourceGroup: group.resourceGroupName,
      virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
      instanceId: "0",
      // The only command IDs Azure accepts on this surface.
      commandId: "FleetDiagnosticsLinux",
      timeoutInSeconds: props.timeoutInSeconds,
      // A stock Ubuntu image lacks the Fleet Diagnostics agent (exit 127);
      // keep the deploy green and assert on the reported execution instead.
      treatFailureAsDeploymentFailure: false,
      tags: props.tags,
    });
    return { group, scaleSet, command };
  });

test.provider(
  "create, re-run, and delete a scale set VM diagnostic run command",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, scaleSet, command } = yield* stack.deploy(
        program({ timeoutInSeconds: 600, tags: { env: "test" } }),
      );
      expect(command.provisioningState).toEqual("Succeeded");
      expect(command.executionState).toEqual("Failed");
      expect(command.exitCode).toEqual(127);
      const setName = scaleSet.virtualMachineScaleSetName;
      const observed = yield* getRunCommand(
        group.resourceGroupName,
        setName,
        command.runCommandName,
      );
      expect(observed.properties?.source?.commandId).toEqual("FleetDiagnosticsLinux");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Diag");

      // In place: a new timeout re-runs the command.
      const updated = yield* stack.deploy(
        program({ timeoutInSeconds: 900, tags: { env: "test" } }),
      );
      expect(updated.command.runCommandId).toEqual(command.runCommandId);
      expect(updated.command.executionState).toEqual("Failed");
      const reobserved = yield* getRunCommand(
        group.resourceGroupName,
        setName,
        command.runCommandName,
      );
      expect(reobserved.properties?.timeoutInSeconds).toEqual(900);

      // Replace: Azure does not update tags in place. The replacement gets
      // a new name, runs again, and the old run command is deleted.
      const retagged = yield* stack.deploy(
        program({ timeoutInSeconds: 900, tags: { env: "prod" } }),
      );
      const newName = retagged.command.runCommandName;
      expect(newName).not.toEqual(command.runCommandName);
      expect(retagged.command.tags).toEqual({ env: "prod" });
      expect(retagged.command.executionState).toEqual("Failed");
      const replaced = yield* getRunCommand(group.resourceGroupName, setName, newName);
      expect(replaced.tags?.env).toEqual("prod");
      expect(
        yield* untilGone(getRunCommand(group.resourceGroupName, setName, command.runCommandName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* untilGone(getRunCommand(group.resourceGroupName, setName, newName))).toEqual(
        "gone",
      );
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 900_000 },
);
